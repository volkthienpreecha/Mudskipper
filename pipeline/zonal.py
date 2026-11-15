"""Aggregate GCOV covariance in linear power on authoritative geo fields.

Falls back to provisional segments only when fields.geojson is absent. Each
pass is sampled on its own map grid. Geo fields retain their contract IDs and
metadata; coverage includes portions of a field outside the cached window.
"""
import json
import os
from pathlib import Path
import numpy as np
from field_units import FieldUnits, sample_grid, cache_matches
from affine import Affine
from freeman_durden import freeman_durden

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
STAGES = (("early", "2026-07-15"), ("mid", "2026-09-10"), ("late", "9999"))
REF_PASS = "p20260702"


def stage_of(date, stages=STAGES):
    return next(s for s, end in stages if date < end)


def db(x):
    return float(np.round(10 * np.log10(x), 3)) if x > 0 else None


def field_id(tile, i):
    return f"{tile}_s{i:05d}"


def on_grid(src, res, x0, y0, x, y, fill=0):
    return sample_grid(src, Affine(res, 0, x0, 0, -res, y0), x, y, fill)


def field_rasters(tile, x, y):
    """Legacy segment API. New callers should use FieldUnits.raster with CRS."""
    with np.load(f"data/{REF_PASS}_{tile}.npz") as ref:
        return FieldUnits(ART).raster(tile, x, y, ref["epsg"])[:2]


def want(tile):
    t = os.environ.get("TILES") or os.environ.get("ONLY_TILE")
    return t is None or tile in t.split(",")


def zonal_records(d, p, tile, fields):
    """One pass/tile, without IO; QP decomposes field means, never pixel dB."""
    required = {"x", "y", "epsg", "HHHH", "HVHV", "mask"}
    if p.get("pol_mode") == "QP":
        required |= {"VVVV", "HHVV"}
    missing = required - set(d.keys())
    if missing:
        raise ValueError(f"{p['pass_id']}/{tile} missing physical raster terms: {sorted(missing)}")
    if p.get("granule_id") and ("granule_id" not in d or str(d["granule_id"]) != p["granule_id"]):
        raise ValueError(f"{p['pass_id']}/{tile} cached granule does not match passes.json")
    lab, crop, totals, meta = fields.raster(tile, d["x"], d["y"], d["epsg"])
    terms = {k: np.asarray(d[k], dtype="c16" if k == "HHVV" else "f8")
             for k in ("HHHH", "HVHV", "VVVV", "HHVV") if k in d}
    if ("VVVV" in terms) != ("HHVV" in terms):
        raise ValueError("quad-pol requires both VVVV and HHVV")
    if "VHVH" in d and "VVVV" in terms:
        terms["HVHV"] = (terms["HVHV"] + np.asarray(d["VHVH"], dtype="f8")) / 2
    if any(a.shape != lab.shape for a in [np.asarray(d["mask"]), *terms.values()]):
        raise ValueError(f"{p['pass_id']}/{tile} raster dimensions differ from x/y grid")
    m = np.asarray(d["mask"])
    ok = (m > 0) & (m < 255)
    if "VHVH" in d and "VVVV" in terms:
        ok &= np.isfinite(d["VHVH"]) & (d["VHVH"] > 0)
    for k, a in terms.items():
        ok &= np.isfinite(a)
        if k != "HHVV":
            ok &= a > 0
    use = ok & crop & (lab > 0)
    nl = len(meta) + 1
    cnt = np.bincount(lab[use], minlength=nl)
    def mean(a):
        return np.bincount(lab[use], weights=a[use], minlength=nl) / np.maximum(cnt, 1)
    means = {k: mean(a.real) + 1j * mean(a.imag) if np.iscomplexobj(a) else mean(a) for k, a in terms.items()}
    qp = "VVVV" in terms
    if qp:
        ps, pd, pv = freeman_durden(means["HHHH"], means["HVHV"], means["VVVV"], means["HHVV"])
    stages = STAGES
    if fields.aoi:
        stages = (("early", fields.aoi["stages"]["mid_start"]),
                  ("mid", fields.aoi["stages"]["late_start"]), ("late", "9999"))
    for i, props in enumerate(meta, 1):
        obs = {"hh_db": None, "hv_db": None, "hh_hv_db": None}
        if qp:
            obs.update(vv_db=None, ps_db=None, pd_db=None, pv_db=None)
        if cnt[i]:
            obs.update(hh_db=db(means["HHHH"][i]), hv_db=db(means["HVHV"][i]),
                       hh_hv_db=db(means["HHHH"][i] / means["HVHV"][i]))
            if qp:
                obs.update({k: db(max(float(a[i]), 1e-8)) for k, a in
                            (("vv_db", means["VVVV"]), ("ps_db", ps), ("pd_db", pd), ("pv_db", pv))})
        yield {"field_id": props["field_id"], "pass_id": p["pass_id"], "tile": tile, "track": p["track"],
               "field_source": props["source"], "area_ha": props["area_ha"],
               **({"field_geometry_sha256": fields.fingerprints[props["field_id"]]} if fields.geo else {}),
               **({"rice_mask_frac": props["rice_mask_frac"]} if fields.geo else {}),
               "n_px": int(cnt[i]), "valid_frac": round(float(cnt[i] / max(totals[i], 1)), 4),
               "stage": stage_of(p["datetime"][:10], stages), "observed": obs}


def main():
    fields = FieldUnits(ART, ref_pass=REF_PASS)
    pp = Path(ART) / "passes.json"
    if not pp.exists():
        raise SystemExit(f"missing {pp}: geo artifacts alone contain no radar passes or measurements")
    passes = [p for p in json.loads(pp.read_text())["passes"] if p["used"]]
    tiles = [t for t in fields.tiles() if want(t)]
    if not passes or not tiles:
        raise SystemExit("no used passes or matching field tiles; provide the radar and field handoffs")
    inputs = [(p, tile, Path("data") / f"{p['pass_id']}_{tile}.npz") for p in passes for tile in tiles]
    missing = [str(path) for _, _, path in inputs if not path.exists()]
    if missing:
        raise SystemExit("missing physical radar caches (run pipeline/fetch.py for this AOI): " + ", ".join(missing[:8]))
    if fields.geo:
        bounds = {t["id"]: t["bbox"] for t in fields.aoi["tiles"]}
        for p, tile, path in inputs:
            if not cache_matches(path, bounds[tile], p["granule_id"]):
                raise SystemExit(f"{path} has no matching AOI/granule/checksum sidecar; rerun pipeline/fetch.py for this AOI")
    n = 0
    pending = Path(ART) / "zonal.jsonl.tmp"
    try:
        with pending.open("w", encoding="utf-8", newline="\n") as out:
            for p, tile, path in inputs:
                with np.load(path) as d:
                    for row in zonal_records(d, p, tile, fields):
                        out.write(json.dumps(row, allow_nan=False) + "\n")
                        n += 1
                print(p["pass_id"], tile, "track", p["track"], f"{len(fields.metadata(tile))} fields")
        pending.replace(Path(ART) / "zonal.jsonl")
    finally:
        pending.unlink(missing_ok=True)
    name = "field_units.jsonl" if fields.geo else "fields_provisional.jsonl"
    with (Path(ART) / name).open("w", encoding="utf-8", newline="\n") as out:
        for tile in tiles:
            for props in fields.metadata(tile):
                out.write(json.dumps(props, allow_nan=False) + "\n")
    print(f"{n} rows -> {ART}/zonal.jsonl")


if __name__ == "__main__":
    main()
