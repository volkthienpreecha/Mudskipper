"""Independent-sensor check: Sentinel-2 optical flooding signal vs NISAR labels.

Optical rule (Xiao et al. 2005, Remote Sens. Environ. 95:480, widely used for paddy
flooding/transplanting detection): a pixel shows flooding when LSWI + 0.05 >= NDVI,
with LSWI = (NIR - SWIR1)/(NIR + SWIR1), NDVI = (NIR - Red)/(NIR + Red).
Per field: share of clear (SCL = vegetation/bare/water/unclassified) pixels passing the rule.
Field is optical-flooded if share >= 0.5, optical-dry if share <= 0.2, else skipped.
Compared with the NISAR label from the nearest pass (<= 2 days apart), non-uncertain only.
Reports agreement, Cohen's kappa, and precision/recall/F1 treating optical as the reference.
Data: Element84 Earth Search STAC, collection sentinel-2-l2a (public, no login).
Output: artifacts/<run>/optical_check.json
"""
import datetime as dt, json, os, sys
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from pystac_client import Client
from sklearn.metrics import cohen_kappa_score, precision_recall_fscore_support
from zonal import on_grid, REF_PASS, field_id

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
CLEAR = {4, 5, 6, 7}  # SCL: vegetation, not vegetated, water, unclassified
MAX_DAYS = 2


def read(href, bounds, shape=None):
    with rasterio.open(href) as s:
        w = from_bounds(*bounds, s.transform)
        a = s.read(1, window=w, out_shape=shape, boundless=True, fill_value=0).astype("f8")
        t = s.window_transform(w)
        if shape is not None:
            t = t * t.scale(w.width / shape[1], w.height / shape[0])
        return a, t


def main():
    tiles = sys.argv[1:] or ["fazilka", "muktsar"]
    dates = {p["pass_id"]: dt.date.fromisoformat(p["datetime"][:10])
             for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    obs = {}
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l)
        obs[(r["field_id"], r["pass_id"])] = r["inferred"]["state"]
    cat = Client.open("https://earth-search.aws.element84.com/v1")
    out = {"rule": "Xiao et al. 2005: LSWI + 0.05 >= NDVI", "pairs": []}
    lab_out = open(os.path.join(ART, "optical_fields.jsonl"), "w")  # per-field optical shares (all, incl. ambiguous)
    ys, ps = [], []
    for tile in tiles:
        ref = np.load(f"data/{REF_PASS}_{tile}.npz")
        x, y = ref["x"], ref["y"]
        seg = np.load(f"data/segments_{tile}.npz")
        bounds = (x[0] - 5, y[-1] - 5, x[-1] + 5, y[0] + 5)  # UTM 43N, same CRS as Sentinel-2 tile 43R
        from pyproj import Transformer
        tr = Transformer.from_crs(int(ref["epsg"]), 4326, always_xy=True)
        lo, la = tr.transform([bounds[0], bounds[2]], [bounds[1], bounds[3]])
        items = cat.search(collections=["sentinel-2-l2a"], bbox=[lo[0], la[0], lo[1], la[1]],
                           datetime=os.environ.get("S2_DATES", "2026-06-25/2026-10-20"), query={"eo:cloud_cover": {"lt": 10}}).items()
        for it in sorted(items, key=lambda i: i.datetime):
            if it.properties.get("proj:epsg", int(ref["epsg"])) != int(ref["epsg"]):
                continue
            d = it.datetime.date()
            near = min(dates, key=lambda k: abs(dates[k] - d))
            if abs(dates[near] - d).days > MAX_DAYS:
                continue
            nir, t10 = read(it.assets["nir"].href, bounds)
            red, _ = read(it.assets["red"].href, bounds)
            sw, _ = read(it.assets["swir16"].href, bounds, shape=nir.shape)
            scl, _ = read(it.assets["scl"].href, bounds, shape=nir.shape)
            with np.errstate(divide="ignore", invalid="ignore"):
                ndvi = (nir - red) / (nir + red)
                lswi = (nir - sw) / (nir + sw)
            wet = (lswi + 0.05 >= ndvi)
            clear = np.isin(scl, list(CLEAR)) & (nir > 0) & np.isfinite(ndvi) & np.isfinite(lswi)
            # sample S2 (10 m) at the field raster: segment labels on S2 pixel centres
            xs = t10.c + (np.arange(nir.shape[1]) + 0.5) * t10.a
            ysr = t10.f + (np.arange(nir.shape[0]) + 0.5) * t10.e
            lab = on_grid(seg["labels"], 10 * int(seg["ml"]), x[0] - 5, y[0] + 5, xs, ysr)
            use = clear & (lab > 0)
            nl = int(seg["labels"].max()) + 1
            n = np.bincount(lab[use], minlength=nl)
            k = np.bincount(lab[use], weights=wet[use], minlength=nl)
            yy, pp = [], []
            for i in np.nonzero(n >= 20)[0]:
                share = k[i] / n[i]
                if d < dt.date(2026, 8, 1):  # optical rule only meaningful before canopy closure
                    lab_out.write(json.dumps({"field_id": field_id(tile, int(i)), "tile": tile, "s2_date": str(d),
                                              "s2_id": it.id, "nisar_pass": near, "n_px": int(n[i]),
                                              "wet_share": round(float(share), 4)}) + chr(10))
                if 0.2 < share < 0.5:
                    continue
                s = obs.get((field_id(tile, int(i)), near))
                if s in ("flooded", "drained"):
                    yy.append(share >= 0.5); pp.append(s == "flooded")
            if len(yy) < 50:
                continue
            yy, pp = np.array(yy), np.array(pp)
            pr, rc, f1, _ = precision_recall_fscore_support(yy, pp, average="binary", zero_division=0)
            row = {"tile": tile, "s2_date": str(d), "s2_id": it.id, "cloud": round(it.properties["eo:cloud_cover"], 1),
                   "nisar_pass": near, "days_apart": abs(dates[near] - d).days, "n_fields": int(len(yy)),
                   "optical_flooded_pct": round(100 * yy.mean(), 1), "nisar_flooded_pct": round(100 * pp.mean(), 1),
                   "agreement_pct": round(100 * (yy == pp).mean(), 1),
                   "kappa": round(float(cohen_kappa_score(yy, pp)), 3),
                   "precision": round(float(pr), 3), "recall": round(float(rc), 3), "f1": round(float(f1), 3)}
            out["pairs"].append(row)
            ys += list(yy); ps += list(pp)
            print(row)
    if ys:
        ys, ps = np.array(ys), np.array(ps)
        out["pooled"] = {"n": int(len(ys)), "agreement_pct": round(100 * (ys == ps).mean(), 1),
                         "kappa": round(float(cohen_kappa_score(ys, ps)), 3)}
        print("pooled", out["pooled"])
    lab_out.close()
    json.dump(out, open(os.path.join(ART, "optical_check.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
