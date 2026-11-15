"""Export an internal pipeline run to the team contract (contracts/CONTRACTS.md v1) as a new run directory.

Internal ids  -> contract ids:
  field  fazilka_s00123 -> fazilka-00123        pass  p20260702 (track 84, A) -> 20260702-T084A
Fields: the contract caps fields.geojson at 5,000. A fixed random sample (seed 0) of rice-like fields is kept,
FIELDS_PER_TILE per tile, so per-pass shares stay unbiased. Polygons are the provisional segments, polygonised
in UTM and reprojected to WGS84 (source "grid": derived on the 20 m raster grid until geo/ fields.geojson lands).
If the run directory already has an aoi.json / fields.geojson from geo/, use those instead (TODO when it lands).
Writes: aoi.json, fields.geojson, passes.json, observations.jsonl, provenance.json, overlays/ (+ index.json), hist/.
Usage: python pipeline/export_contract.py [in_run=r01] [out_run=r01v1]
"""
import datetime as dt, glob, hashlib, json, os, shutil, subprocess, sys
import numpy as np
import rasterio.features
from affine import Affine
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform  # noqa

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
        return v
    return hashlib.sha256("".join(f"{t}:{v[t]}" for t in tiles if t in v).encode()).hexdigest()


def pid(p):
    return f"{p['datetime'][:10].replace('-', '')}-T{int(p['track']):03d}{p['direction'][0].upper()}"


def fid(internal):
    tile, n = internal.rsplit("_s", 1)
    return f"{tile}-{int(n):05d}"


def warp_overlay(src_png, dst_png, tile, bbox):
    """Reproject an overlay PNG from the UTM field grid onto a north-up lon/lat grid covering the tile bbox
    (B3.10 wants the bbox corners). Nearest neighbour, so class colours are unchanged."""
    from PIL import Image
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    ref = np.load(f"data/p20260702_{tile}.npz")
    a = np.array(Image.open(src_png).convert("RGBA"))
    h, w = a.shape[:2]
    res = (ref["x"][-1] - ref["x"][0] + 10) / w
    src_tf = Affine(res, 0, ref["x"][0] - 5, 0, -res, ref["y"][0] + 5)
    dst_tf = from_bounds(*bbox, w, h)
    out = np.zeros_like(a)
    for k in range(4):
        reproject(a[..., k], out[..., k], src_transform=src_tf, src_crs=f"EPSG:{int(ref['epsg'])}",
                  dst_transform=dst_tf, dst_crs="EPSG:4326", resampling=Resampling.nearest)
    Image.fromarray(out, "RGBA").save(dst_png)


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
    if os.path.exists(DST):
        shutil.rmtree(DST)
    os.makedirs(os.path.join(DST, "overlays"))
    head = {"v": 1, "run_id": OUT}
    passes = json.load(open(os.path.join(SRC, "passes.json")))["passes"]
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
    rows = [json.loads(l) for l in open(os.path.join(SRC, "observations.jsonl"))]
    tiles = sorted({r["tile"] for r in rows})
    notrice = {r["field_id"] for r in rows if "not_rice_like" in r["flags"]}
    rng = np.random.default_rng(0); keep = set()
    for t in tiles:
        cand = sorted({r["field_id"] for r in rows if r["tile"] == t and r["field_id"] not in notrice})
        keep |= set(rng.choice(cand, min(FIELDS_PER_TILE, len(cand)), replace=False).tolist())
    allowed_obs = {"hh_db", "hv_db", "vv_db", "ps_db", "pd_db", "pv_db", "hh_hv_db"}
    with open(os.path.join(DST, "observations.jsonl"), "w") as f:
        for r in rows:
            if r["field_id"] not in keep or r["pass_id"] not in idmap:
                continue
            o = {k: v for k, v in r["observed"].items() if k in allowed_obs}
            if r["valid_frac"] > 0 and o.get("hh_db") is None:
                continue  # contract: observed may be null only when valid_frac is 0
            pf = r["inferred"]["p_flooded"]
            inf = {"state": r["inferred"]["state"], "p_flooded": pf,
                   "confidence": None if pf is None else round(abs(2 * pf - 1), 4), "method": r["inferred"]["method"]}
            f.write(json.dumps({**head, "field_id": fid(r["field_id"]), "pass_id": idmap[r["pass_id"]], "n_px": r["n_px"],
                                "valid_frac": r["valid_frac"], "observed": o, "stage": r["stage"], "inferred": inf,
                                "flags": sorted(set(r["flags"]))}) + "\n")
    # ---- fields.geojson + aoi.json
    feats, aoi_tiles = [], []
    ref_pass = "p20260702"
    for t in tiles:
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
            area = float(seg["area_ha"][i]); cf = float(seg["crop_frac"][i])
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
    json.dump({**head, "tiles": aoi_tiles, "utm_epsg": 32643, "season": {"start": "2026-06-17", "end": "2026-10-23"},
               "stages": {"mid_start": "2026-07-15", "late_start": "2026-09-10"},
               "gaps": [{"start": "2026-07-27T22:03:25Z", "end": "2026-08-10T00:55:27Z",
                         "source": "https://nisar-docs.asf.alaska.edu/availability-overview/"}]},
              open(os.path.join(DST, "aoi.json"), "w"), indent=1)
    # ---- overlays + hist
    ov = []
    for o in json.load(open(os.path.join(SRC, "overlays", "index.json"))):
        if o["pass_id"] not in idmap:
            continue
        name = f"overlays/{idmap[o['pass_id']]}_{o['tile']}.png"
        b = next(a["bbox"] for a in aoi_tiles if a["id"] == o["tile"])
        warp_overlay(os.path.join(SRC, o["url"]), os.path.join(DST, name), o["tile"], b)
        ov.append({"pass_id": idmap[o["pass_id"]], "tile": o["tile"], "url": name,
                   "coordinates": [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]})
    json.dump({**head, "overlays": ov}, open(os.path.join(DST, "overlays", "index.json"), "w"), indent=1)
    hist_by_stage(DST)
    # ---- provenance (last: hashes the files above)
    prov = json.load(open(os.path.join(SRC, "provenance.json")))
    used_g = {p["granule_id"] for p in passes if p["used"]}
    try:
        git = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except Exception:
        git = ""
    arts = [{"path": os.path.relpath(p, DST).replace(os.sep, "/"), "sha256": sha(p)}
            for p in sorted(glob.glob(os.path.join(DST, "**", "*"), recursive=True))
            if os.path.isfile(p) and not p.endswith("provenance.json")]
    dc = prov.get("decomposition_check") or {}
    json.dump({**head, "git_sha": git if len(git) >= 7 else "0000000",
               "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "granules": [{"granule_id": g["granule_id"], "crid": g.get("crid", "P05023"), "subset_sha256": gsha(g["subset_sha256"], tiles)}
                            for g in prov["granules"] if g["granule_id"] in used_g],
               "artifacts": arts,
               "decomposition_check": {"reference": dc.get("reference", "not run"), "max_abs_diff_db": dc.get("max_abs_diff_db")}},
              open(os.path.join(DST, "provenance.json"), "w"), indent=1)
    print(f"{OUT}: {len(feats)} fields, {len(idmap)} used passes, {len(ov)} overlays")


if __name__ == "__main__":
    main()
