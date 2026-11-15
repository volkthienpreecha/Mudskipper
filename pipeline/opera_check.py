"""B3.8 OPERA cross-check: OPERA DSWx-S1 surface water vs our flooded share, per tile and date.

OPERA DSWx-NI (NISAR-based) is not yet published over the study area, so the Sentinel-1 based
OPERA_L3_DSWX-S1_V1 (30 m, v1.0) is used. Layer B01_WTR: 0 not water, 1 open water, 2 partial surface water,
others masked/fill. Only pixels inside our provisional fields count (cropland), so the two fractions cover the
same land. A DSWx date within +-2 days of a used NISAR pass is paired with it.
Caveats (also in `note`): 30 m pixels cannot resolve fields under ~3 ha and miss water under a dense canopy; the
July NISAR labels already fuse Sentinel-1, so July pairs are not fully independent.
Output: artifacts/<run>/opera_pairs.json (read by export_contract.py into checks.json)
"""
import datetime as dt, json, os, re
import numpy as np
import earthaccess, rasterio
from rasterio.warp import reproject, Resampling
from affine import Affine
from zonal import REF_PASS, on_grid

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
TILES = os.environ.get("TILES", "fazilka,muktsar").split(",")
MAX_DAYS = 2


def main():
    earthaccess.login(strategy="netrc")
    passes = {p["pass_id"]: dt.date.fromisoformat(p["datetime"][:10])
              for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    share = {}
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l)
        s = r["inferred"]["state"]
        if s in ("flooded", "drained"):
            k = (r["tile"], r["pass_id"]); c = share.setdefault(k, [0, 0]); c[0] += s == "flooded"; c[1] += 1
    res = earthaccess.search_data(short_name="OPERA_L3_DSWX-S1_V1", bounding_box=(73.9, 30.3, 74.7, 30.6),
                                  temporal=("2026-06-15", "2026-10-25"))
    pairs, dates = [], set()
    fs = earthaccess.get_fsspec_https_session()
    for tile in TILES:
        ref = np.load(f"data/{REF_PASS}_{tile}.npz"); seg = np.load(f"data/segments_{tile}.npz")
        x, y = ref["x"], ref["y"]; H, W = len(y), len(x)
        dst_tf = Affine(10, 0, x[0] - 5, 0, -10, y[0] + 5)
        lab = on_grid(seg["labels"], 10 * int(seg["ml"]), x[0] - 5, y[0] + 5, x, y) > 0
        acc = {}  # opera date -> [water px, valid px] (several MGRS tiles may overlap the tile)
        for g in res:
            gid = g["meta"]["native-id"]
            d = dt.datetime.strptime(re.search(r"_(\d{8})T\d{6}Z_", gid).group(1), "%Y%m%d").date()
            near = min(passes, key=lambda p: abs(passes[p] - d))
            if abs(passes[near] - d).days > MAX_DAYS:
                continue
            url = next(u for u in g.data_links() if u.endswith("_B01_WTR.tif"))
            with fs.open(url) as fh, rasterio.open(fh) as src:
                out = np.full((H, W), 255, np.uint8)
                reproject(src.read(1), out, src_transform=src.transform, src_crs=src.crs, dst_transform=dst_tf,
                          dst_crs=f"EPSG:{int(ref['epsg'])}", resampling=Resampling.nearest, dst_nodata=255)
            ok = lab & (out <= 2)
            a = acc.setdefault((d, near), [0, 0]); a[0] += int((ok & (out >= 1)).sum()); a[1] += int(ok.sum())
        for (d, near), (wat, val) in sorted(acc.items()):
            if val < 1000 or (tile, near) not in share:
                continue
            f, n = share[(tile, near)]
            pairs.append({"date": str(passes[near]), "tile": tile, "ours_flooded_frac": round(f / n, 4),
                          "opera_water_frac": round(wat / val, 4), "opera_date": str(d)})
            dates.add(str(d))
            print(pairs[-1], flush=True)
    out = {"product": "OPERA_L3_DSWX-S1_V1 (DSWx-NI not yet published over the study area)", "version": "1.0",
           "n_dates": len(dates), "pairs": pairs,
           "note": "OPERA DSWx is 30 m: fields under ~3 ha are not resolved and water under a dense rice canopy is "
                   "largely invisible to it, so OPERA water fractions are expected to be far below our flooded share "
                   "in the canopy season. Only pixels inside our fields count. July NISAR labels fuse Sentinel-1, so "
                   "July pairs are not fully independent of this Sentinel-1 based product."}
    json.dump(out, open(os.path.join(ART, "opera_pairs.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
