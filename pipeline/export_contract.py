"""Export an internal pipeline run to the team contract (contracts/CONTRACTS.md v1) as a new run directory.

Internal ids  -> contract ids:
  field  fazilka_s00123 -> fazilka-00123        pass  p20260702 (track 84, A) -> 20260702-T084A
Fields: the contract caps fields.geojson at 5,000. A fixed random sample (seed 0) of rice-like fields is kept,
FIELDS_PER_TILE per tile, so per-pass shares stay unbiased. Polygons are the provisional segments, polygonised
in UTM and reprojected to WGS84 (source "grid": derived on the 20 m raster grid until geo/ fields.geojson lands).
Geo aoi.json / fields.geojson are authoritative when present; their field IDs,
geometry, area, source and rice fractions survive export unchanged.
Writes: aoi.json, fields.geojson, passes.json, observations.jsonl, provenance.json, overlays/ (+ index.json), hist/.
Usage: python pipeline/export_contract.py [in_run=r01] [out_run=r01v1]
"""
import datetime as dt, glob, hashlib, json, os, re, shutil, sys
import numpy as np
import rasterio.features
from affine import Affine
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform  # noqa
from field_units import FieldUnits

IN = sys.argv[1] if len(sys.argv) > 1 else "r01"
OUT = sys.argv[2] if len(sys.argv) > 2 else "r01v1"
SRC, DST = os.path.join("artifacts", IN), os.path.join("artifacts", OUT)
FIELDS_PER_TILE = 2500
DISTRICT = {"fazilka": "Fazilka", "muktsar": "Sri Muktsar Sahib", "bathinda": "Bathinda"}
EXCLUDE_MAP = [("gap", "in_data_gap"), ("season", "outside_season"), ("crid", "crid_mismatch"),
               ("supersed", "duplicate_product"), ("duplicate", "duplicate_product"), ("outlier", "processing_failed")]


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def gsha(v, tiles):
    """One checksum per granule: our fetch hashes each tile subset, so combine this run's tiles in order."""
    if isinstance(v, str):
        if not re.fullmatch(r"[0-9a-f]{64}", v):
            raise ValueError("source provenance contains an invalid subset checksum")
        return v
    if not v or not all(t in v and re.fullmatch(r"[0-9a-f]{64}", v[t]) for t in tiles):
        raise ValueError("source provenance is missing physical subset checksums for selected tiles")
    return hashlib.sha256("".join(f"{t}:{v[t]}" for t in tiles if t in v).encode()).hexdigest()


def granule_list(passes, prov, tiles):
    """Every pass in passes.json (used or excluded) gets a granule entry (T3). Used passes carry the subset hash;
    excluded passes carry it when a subset was cached, else null."""
    by = {g["granule_id"]: g for g in prov["granules"]}
    out, seen = [], set()
    for p in passes:
        gid = p["granule_id"]
        if gid in seen:
            continue
        seen.add(gid)
        g = by.get(gid)
        if p["used"] and not g:
            raise ValueError(f"used granule {gid} has no source provenance")
        out.append({"granule_id": gid, "crid": p["crid"], "subset_sha256": gsha(g["subset_sha256"], tiles) if g else None})
    return out


def pid(p):
    return f"{p['datetime'][:10].replace('-', '')}-T{int(p['track']):03d}{p['direction'][0].upper()}"


def fid(internal):
    if re.fullmatch(r"[a-z][a-z0-9]{0,15}-\d{5}", internal):
        return internal
    tile, n = internal.rsplit("_s", 1)
    return f"{tile}-{int(n):05d}"


def select_fields(rows, fields):
    """Keep geo identity intact; record every explicit, deterministic sample."""
    by_tile = {}
    available = {p["field_id"]: p for t in fields.tiles() for p in fields.metadata(t)}
    for row in rows:
        f = row["field_id"]
        if f not in available or available[f]["tile"] != row["tile"]:
            raise ValueError(f"observation {f} has no matching field geometry/tile; rerun zonal/classify")
        if fields.geo and row.get("field_source") != available[f]["source"]:
            raise ValueError(f"observation {f} lacks matching geo field_source; rerun zonal/classify")
        if fields.geo and row.get("field_geometry_sha256") != fields.fingerprints[f]:
            raise ValueError(f"observation {f} does not match this geo geometry/metadata; rerun zonal/classify")
        by_tile.setdefault(row["tile"], set()).add(f)
    notrice = {r["field_id"] for r in rows if "not_rice_like" in r["flags"] or "not_rice_2024" in r["flags"]}
    if not by_tile:
        raise ValueError("no observations to export")
    if fields.geo:
        for tile, ids in by_tile.items():
            absent = {p["field_id"] for p in fields.metadata(tile)} - ids
            if absent:
                raise ValueError(f"{len(absent)} geo fields in {tile} have no measurements; rerun zonal/classify")
    # The contract allows 5,000 total, not 2,500 for each of arbitrarily many tiles.
    all_ids = set().union(*by_tile.values())
    all_geo = fields.geo and len(all_ids) <= 5000
    quota = 5000 if all_geo else min(FIELDS_PER_TILE, 5000 // len(by_tile))
    rng = np.random.default_rng(0)
    keep = set()
    for tile, ids in sorted(by_tile.items()):
        cand = sorted(ids if fields.geo else ids - notrice)
        keep.update(rng.choice(cand, min(quota, len(cand)), replace=False).tolist())
    if not keep:
        raise ValueError("no eligible field observations to export")
    excluded = sorted(set().union(*by_tile.values()) - keep)
    return keep, {"rule": "all_geo_fields" if all_geo else "seed_0_equal_tile_sample", "seed": 0, "contract_limit": 5000,
                  "per_tile_limit": None if all_geo else quota, "field_source": "geo" if fields.geo else "segments",
                  "input_fields": len(set().union(*by_tile.values())), "selected_fields": len(keep),
                  "selected_ids": sorted(keep), "excluded_ids": excluded}


def geo_export_fields(fields, keep, head):
    """No re-numbering, geometry simplification, area/rice clamping or label substitution."""
    features = [f for fs in fields.by_tile.values() for f in fs if f["properties"]["field_id"] in keep]
    features.sort(key=lambda f: f["properties"]["field_id"])
    if {f["properties"]["field_id"] for f in features} != keep:
        raise ValueError("selected field IDs are absent from geo handoff")
    tiles = {f["properties"]["tile"] for f in features}
    aoi = {**fields.aoi, **head, "tiles": [t for t in fields.aoi["tiles"] if t["id"] in tiles]}
    return {**fields.collection, **head, "features": features}, aoi


def warp_overlay(src_png, dst_png, tile, bbox, grid=None, fields=None, keep=None):
    """Reproject an overlay PNG from the UTM field grid onto a north-up lon/lat grid covering the tile bbox
    (B3.10 wants the bbox corners). Nearest neighbour, so class colours are unchanged."""
    from PIL import Image
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    a = np.array(Image.open(src_png).convert("RGBA"))
    h, w = a.shape[:2]
    if grid:
        if [w, h] != [grid["width"], grid["height"]]:
            raise ValueError("overlay grid metadata and PNG dimensions differ")
        src_tf, src_crs = Affine(*grid["transform"]), grid["epsg"]
        if fields is not None:
            x = src_tf.c + (np.arange(w) + .5) * src_tf.a
            y = src_tf.f + (np.arange(h) + .5) * src_tf.e
            lab, _, _, meta = fields.raster(tile, x, y, src_crs)
            selected = np.array([False] + [p["field_id"] in keep for p in meta])
            a[~selected[lab], 3] = 0
    else:
        ref = np.load(f"data/p20260702_{tile}.npz")
        res = (ref["x"][-1] - ref["x"][0] + 10) / w
        src_tf = Affine(res, 0, ref["x"][0] - 5, 0, -res, ref["y"][0] + 5)
        src_crs = int(ref["epsg"])
    dst_tf = from_bounds(*bbox, w, h)
    out = np.zeros_like(a)
    for k in range(4):
        reproject(a[..., k], out[..., k], src_transform=src_tf, src_crs=f"EPSG:{src_crs}",
                  dst_transform=dst_tf, dst_crs="EPSG:4326", resampling=Resampling.nearest)
    Image.fromarray(out, "RGBA").save(dst_png)


def write_checks(dst, head):
    """checks.json (B3.8): season shape from the exported observations + OPERA pairs from opera_check.py."""
    rows = [json.loads(l) for l in open(os.path.join(dst, "observations.jsonl"))]
    pct = {}
    for stg in ("early", "mid", "late"):
        clear = [r for r in rows if r["stage"] == stg and r["inferred"]["state"] != "uncertain"]
        pct[stg] = round(100 * sum(r["inferred"]["state"] == "flooded" for r in clear) / len(clear), 2) if clear else None
    by_pass = {}
    for r in rows:
        if r["inferred"]["state"] != "uncertain":
            c = by_pass.setdefault(r["pass_id"], [0, 0]); c[0] += r["inferred"]["state"] == "flooded"; c[1] += 1
    share = {p: f / n for p, (f, n) in by_pass.items()}
    last = max(share, key=lambda p: p[:8]) if share else None
    peak_stage = max((v for k, v in pct.items() if k != "early" and v is not None), default=None)
    ok = (pct["early"] is not None and peak_stage is not None and pct["early"] < peak_stage
          and last is not None and share[last] < max(share.values()))
    opera = None
    op = os.path.join(SRC, "opera_pairs.json")
    if os.path.exists(op):
        o = json.load(open(op)); inv = {}
        for p in json.load(open(os.path.join(dst, "passes.json")))["passes"]:
            inv[p["datetime"][:10]] = p["pass_id"]
        opera = {k: o[k] for k in ("product", "version", "pairs", "note")}
        opera["n_dates"] = len({p["date"] for p in o["pairs"]})  # distinct pair dates (validator rule)
    json.dump({**head, "season_shape": {"pct_flooded_by_stage": pct, "pass": bool(ok),
                                        "rule": "Flooding should rise from the early stage (before transplanting) to a "
                                                "mid/late-season peak, and the last pass should be below the season peak "
                                                "(pre-harvest drain); pass is true when both hold."},
               "opera": opera}, open(os.path.join(dst, "checks.json"), "w"), indent=1)


def hist_by_stage(dst):
    """hist/<stage>.png (B3.10): HH and HH/HV of exported observations, flooded vs drained vs uncertain."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(os.path.join(dst, "hist"), exist_ok=True)
    rows = [json.loads(l) for l in open(os.path.join(dst, "observations.jsonl"))]
    for stg in ("early", "mid", "late"):
        rs = [r for r in rows if r["stage"] == stg and r["observed"]["hh_db"] is not None]
        if not rs:
            continue
        fig, axs = plt.subplots(1, 2, figsize=(9, 3.2))
        for ax, k in zip(axs, ("hh_db", "hh_hv_db")):
            v = np.array([r["observed"][k] for r in rs]); lo, hi = np.percentile(v, [0.5, 99.5])
            for st, col in (("flooded", "#3FA7D6"), ("drained", "#C98B4E"), ("uncertain", "#8A8F98")):
                ax.hist([r["observed"][k] for r in rs if r["inferred"]["state"] == st], bins=60, range=(lo, hi),
                        alpha=0.6, color=col, label=st)
            ax.set_title(f"{stg}: {k}", fontsize=9)
        axs[0].legend(); fig.tight_layout()
        fig.savefig(os.path.join(dst, "hist", f"{stg}.png"), dpi=90); plt.close(fig)


def main():
    if (not all(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", r) for r in (IN, OUT)) or IN == OUT):
        raise SystemExit("input/output must be distinct contract run IDs under artifacts/")
    fields = FieldUnits(SRC)
    # Validate the geometry/measurement join before replacing any previous export.
    rows = [json.loads(l) for l in open(os.path.join(SRC, "observations.jsonl"))]
    keep, selection = select_fields(rows, fields)
    passes = json.load(open(os.path.join(SRC, "passes.json")))["passes"]
    expected = {(f, p["pass_id"]) for f in keep for p in passes if p["used"]}
    pairs = [(r["field_id"], r["pass_id"]) for r in rows if r["field_id"] in keep]
    if set(pairs) != expected or len(pairs) != len(expected):
        raise ValueError("selected fields require exactly one observation for every used pass; rerun zonal/classify")
    if any(r["valid_frac"] > 0 and r["observed"].get("hh_db") is None for r in rows):
        raise ValueError("nonzero valid coverage requires actual backscatter; refusing to drop missing measurements")
    tiles = sorted({r["tile"] for r in rows})
    prov = json.load(open(os.path.join(SRC, "provenance.json")))
    granules = granule_list(passes, prov, tiles)
    git = os.environ.get("RUN_GIT_SHA", prov.get("git_sha") or "")
    if not re.fullmatch(r"[0-9a-f]{7,40}", git):
        raise ValueError("source provenance requires its real git_sha (or explicit RUN_GIT_SHA)")
    created = os.environ.get("RUN_CREATED_AT", prov.get("created_at") or "")
    if created.endswith("+00:00"):
        created = created[:-6] + "Z"
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", created):
        raise ValueError("source provenance requires its UTC created_at (or explicit RUN_CREATED_AT)")
    if os.path.exists(DST):
        shutil.rmtree(DST)
    os.makedirs(os.path.join(DST, "overlays"))
    head = {"v": 1, "run_id": OUT}
    # ---- passes.json
    idmap, seen, out_passes = {}, set(), []
    for p in passes:
        q = {k: p[k] for k in ("granule_id", "datetime", "direction", "track", "frame", "pol_mode", "covariance_terms",
                               "crid", "maturity", "pixel_m", "valid_fraction_by_tile", "used")}
        base = pid(p); i = base
        if i in seen:
            i = f"{base}-dup{sum(s.startswith(base) for s in seen)}"
        seen.add(i)
        q["pass_id"] = i
        if p["used"]:
            idmap[p["pass_id"]] = i
            q["excluded_reason"] = None
        else:
            why = (p["excluded_reason"] or "").lower()
            q["excluded_reason"] = next((e for k, e in EXCLUDE_MAP if k in why), "processing_failed")
        if not q["covariance_terms"]:
            q["covariance_terms"] = ["HHHH", "HVHV"] if p["pol_mode"] == "DH" else ["HHHH", "HVHV", "VVVV", "HHVV"]
        if q["pixel_m"] is None:
            q["pixel_m"] = 10.0 if p["pol_mode"] == "DH" else 20.0
        out_passes.append(q)
    json.dump({**head, "passes": out_passes}, open(os.path.join(DST, "passes.json"), "w"), indent=1)
    # ---- observations: pick the field sample
    rp = {}
    if os.path.exists(os.path.join(SRC, "rice_prior.jsonl")):
        rp = {json.loads(l)["field_id"]: json.loads(l)["rice_frac_2024"] for l in open(os.path.join(SRC, "rice_prior.jsonl"))}
    json.dump({**head, **selection}, open(os.path.join(DST, "field_selection.json"), "w"), indent=1)
    allowed_obs = {"hh_db", "hv_db", "vv_db", "ps_db", "pd_db", "pv_db", "hh_hv_db"}
    with open(os.path.join(DST, "observations.jsonl"), "w") as f:
        for r in rows:
            if r["field_id"] not in keep or r["pass_id"] not in idmap:
                continue
            o = {k: v for k, v in r["observed"].items() if k in allowed_obs}
            pf = r["inferred"]["p_flooded"]
            inf = {"state": r["inferred"]["state"], "p_flooded": pf,
                   "confidence": None if pf is None else round(abs(2 * pf - 1), 4), "method": r["inferred"]["method"]}
            f.write(json.dumps({**head, "field_id": fid(r["field_id"]), "pass_id": idmap[r["pass_id"]], "n_px": r["n_px"],
                                "valid_frac": r["valid_frac"], "observed": o, "stage": r["stage"], "inferred": inf,
                                "flags": sorted(set(r["flags"]))}) + "\n")
    # ---- fields.geojson + aoi.json
    feats, aoi_tiles = [], []
    if fields.geo:
        collection, aoi = geo_export_fields(fields, keep, head)
        feats, aoi_tiles = collection["features"], aoi["tiles"]
    ref_pass = "p20260702"
    for t in ([] if fields.geo else tiles):
        ref = np.load(f"data/{ref_pass}_{t}.npz"); seg = np.load(f"data/segments_{t}.npz")
        res = 10 * int(seg["ml"]); lab = seg["labels"].astype("int32")
        tf = Affine(res, 0, ref["x"][0] - 5, 0, -res, ref["y"][0] + 5)
        tr = Transformer.from_crs(int(ref["epsg"]), 4326, always_xy=True)
        want = {int(k.rsplit("-", 1)[1]) for k in map(fid, keep) if k.startswith(t + "-")}
        geoms = {}
        for g, v in rasterio.features.shapes(lab, mask=np.isin(lab, list(want)), transform=tf):
            geoms.setdefault(int(v), []).append(shape(g))
        for i in sorted(want):
            if i not in geoms:
                continue
            from shapely.ops import unary_union
            gu = shp_transform(tr.transform, unary_union(geoms[i]).simplify(5))
            area = float(seg["area_ha"][i - 1])  # segment labels start at 1; area_ha/crop_frac are 0-based
            cf = rp.get(f"{t}_s{i:05d}", float(seg["crop_frac"][i - 1]))  # rice_mask_frac: 2024 rice map share
            c = gu.representative_point()
            feats.append({"type": "Feature", "id": f"{t}-{i:05d}", "geometry": mapping(gu),
                          "properties": {"field_id": f"{t}-{i:05d}", "tile": t, "district": DISTRICT[t],
                                         "area_ha": round(max(area, 0.5), 3), "source": "grid",
                                         "rice_mask_frac": round(min(max(cf, 0.5), 1.0), 3),
                                         "lon": round(c.x, 6), "lat": round(c.y, 6)}})
        x0, x1, y0, y1 = ref["x"][0] - 5, ref["x"][-1] + 5, ref["y"][-1] - 5, ref["y"][0] + 5
        xs, ys = tr.transform([x0, x1, x1, x0], [y0, y0, y1, y1])
        aoi_tiles.append({"id": t, "district": DISTRICT[t], "bbox": [round(min(xs) - 1e-4, 4), round(min(ys) - 1e-4, 4),
                                                                      round(max(xs) + 1e-4, 4), round(max(ys) + 1e-4, 4)]})
    json.dump({**head, "type": "FeatureCollection", "features": feats}, open(os.path.join(DST, "fields.geojson"), "w"))
    json.dump(aoi if fields.geo else {**head, "tiles": aoi_tiles, "utm_epsg": 32643, "season": {"start": "2026-06-17", "end": "2026-10-23"},
               "stages": {"mid_start": "2026-07-15", "late_start": "2026-09-10"},
               "gaps": [{"start": "2026-07-27T22:03:25Z", "end": "2026-08-10T00:55:27Z",
                         "source": "https://nisar-docs.asf.alaska.edu/availability-overview/"}]},
              open(os.path.join(DST, "aoi.json"), "w"), indent=1)
    # ---- overlays + hist
    ov = []
    for o in json.load(open(os.path.join(SRC, "overlays", "index.json"))):
        if o["pass_id"] not in idmap:
            continue
        if fields.geo and (not o.get("grid") or o.get("field_source") != "geo"):
            raise ValueError("geo export requires overlays regenerated on the same geo fields")
        if fields.geo and any(o.get("field_geometry_sha256", {}).get(f) != fields.fingerprints.get(f, "missing")
                              for f in o.get("field_ids", [])):
            raise ValueError("overlay field geometry/metadata differs from this geo handoff")
        name = f"overlays/{idmap[o['pass_id']]}_{o['tile']}.png"
        b = next(a["bbox"] for a in aoi_tiles if a["id"] == o["tile"])
        warp_overlay(os.path.join(SRC, o["url"]), os.path.join(DST, name), o["tile"], b, o.get("grid"),
                     fields if fields.geo else None, keep)
        ov.append({"pass_id": idmap[o["pass_id"]], "tile": o["tile"], "url": name,
                   "coordinates": [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]})
    json.dump({**head, "overlays": ov}, open(os.path.join(DST, "overlays", "index.json"), "w"), indent=1)
    hist_by_stage(DST)
    write_checks(DST, head)
    # ---- provenance (last: hashes the files above)
    arts = [{"path": os.path.relpath(p, DST).replace(os.sep, "/"), "sha256": sha(p)}
            for p in sorted(glob.glob(os.path.join(DST, "**", "*"), recursive=True))
            if os.path.isfile(p) and not p.endswith("provenance.json")]
    dc = prov.get("decomposition_check") or {}
    json.dump({**head, "git_sha": git, "created_at": created,
               "granules": granules,
               "artifacts": arts,
               "decomposition_check": {"reference": dc.get("reference", "not run"), "max_abs_diff_db": dc.get("max_abs_diff_db")}},
              open(os.path.join(DST, "provenance.json"), "w"), indent=1)
    print(f"{OUT}: {len(feats)} fields, {len(idmap)} used passes, {len(ov)} overlays")


if __name__ == "__main__":
    main()
