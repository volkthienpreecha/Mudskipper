"""Steps 3+4 (dual-pol path): mask each cached tile and compute per-field stats.

Field units, in order of preference:
  1. artifacts/<run>/fields.geojson from geo/ (rasterised)  -> TODO when it lands
  2. data/segments_<tile>.npz from segments.py (provisional, source "segments")
Only valid cropland pixels are averaged (GCOV mask + WorldCover cropland).
Averages are taken in linear power, then converted to dB (B3.4).
Every pass is mapped onto the field raster by map coordinates, so passes from
different tracks (slightly different windows) line up exactly.
Output: artifacts/<run>/zonal.jsonl, artifacts/<run>/fields_provisional.jsonl
"""
import glob, json, os
import numpy as np

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
STAGES = (("early", "2026-07-15"), ("mid", "2026-09-10"), ("late", "9999"))
REF_PASS = "p20260702"  # segments + land cover are defined on this pass's grid (track 084)


def stage_of(date, stages=STAGES):
    return next(s for s, end in stages if date < end)


def db(x):
    return float(np.round(10 * np.log10(x), 3)) if x > 0 else None


def field_id(tile, i):
    return f"{tile}_s{i:05d}"


def on_grid(src, res, x0, y0, x, y, fill=0):
    """Sample raster `src` (cell size `res`, top-left corner x0,y0) at pixel centres x,y."""
    col = np.floor((x - x0) / res).astype(int)
    row = np.floor((y0 - y) / res).astype(int)
    ok = ((row >= 0) & (row < src.shape[0]))[:, None] & ((col >= 0) & (col < src.shape[1]))[None, :]
    out = src[np.clip(row, 0, src.shape[0] - 1)][:, np.clip(col, 0, src.shape[1] - 1)]
    return np.where(ok, out, fill)


def field_rasters(tile, x, y):
    """(labels, cropland) for a tile, sampled at pixel centres x,y."""
    ref = np.load(f"data/{REF_PASS}_{tile}.npz")
    x0, y0 = ref["x"][0] - 5, ref["y"][0] + 5
    seg = np.load(f"data/segments_{tile}.npz")
    lab = on_grid(seg["labels"], 10 * int(seg["ml"]), x0, y0, x, y)
    crop = on_grid(np.load(f"data/landcover_{tile}.npz")["crop"], 10, x0, y0, x, y, fill=False)
    return lab, crop


def main():
    if os.path.exists(os.path.join(ART, "fields.geojson")):
        raise SystemExit("fields.geojson found: polygon rasterisation not wired yet (TODO), refusing to silently use segments")
    passes = {p["pass_id"]: p for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    n = 0
    with open(os.path.join(ART, "fields_provisional.jsonl"), "w") as ff:
        for path in sorted(glob.glob("data/segments_*.npz")):
            tile = os.path.basename(path)[9:-4]
            if os.environ.get("ONLY_TILE", tile) != tile:
                continue
            s = np.load(path)
            for i, (a, c) in enumerate(zip(s["area_ha"], s["crop_frac"]), 1):
                ff.write(json.dumps({"field_id": field_id(tile, i), "tile": tile, "area_ha": round(float(a), 2),
                                     "source": "segments", "crop_frac": round(float(c), 3)}) + "\n")
    with open(os.path.join(ART, "zonal.jsonl"), "w") as out:
        for path in sorted(glob.glob("data/p2026*_*.npz")):
            pass_id, tile = os.path.basename(path)[:-4].split("_", 1)
            if pass_id not in passes or os.environ.get("ONLY_TILE", tile) != tile:
                continue
            d = np.load(path)
            lab, crop = field_rasters(tile, d["x"], d["y"])
            hh, hv, m = d["HHHH"].astype("f8"), d["HVHV"].astype("f8"), d["mask"]
            # mask: 0 = partially focused/invalid, 255 = outside swath, 1..n = valid subswath
            ok = (m > 0) & (m < 255) & np.isfinite(hh) & np.isfinite(hv) & (hh > 0) & (hv > 0)
            use = ok & crop & (lab > 0)
            nl = int(np.load(f"data/segments_{tile}.npz")["labels"].max()) + 1
            tot = np.bincount(lab[crop & (lab > 0)], minlength=nl)
            cnt = np.bincount(lab[use], minlength=nl)
            sh = np.bincount(lab[use], weights=hh[use], minlength=nl)
            sv = np.bincount(lab[use], weights=hv[use], minlength=nl)
            date = passes[pass_id]["datetime"][:10]
            for i in range(1, nl):
                rec = {"field_id": field_id(tile, i), "pass_id": pass_id, "tile": tile, "track": passes[pass_id]["track"],
                       "n_px": int(cnt[i]), "valid_frac": round(float(cnt[i] / max(tot[i], 1)), 4),
                       "stage": stage_of(date), "observed": {"hh_db": None, "hv_db": None, "hh_hv_db": None}}
                if cnt[i]:
                    h, x = sh[i] / cnt[i], sv[i] / cnt[i]
                    rec["observed"] = {"hh_db": db(h), "hv_db": db(x), "hh_hv_db": db(h / x)}
                out.write(json.dumps(rec) + "\n")
                n += 1
            print(pass_id, tile, "track", passes[pass_id]["track"], f"{nl - 1} fields")
    print(f"{n} rows -> {ART}/zonal.jsonl")


if __name__ == "__main__":
    main()
