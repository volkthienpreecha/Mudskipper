"""Provisional field units from the radar time series (until geo/ ships fields.geojson).

Felzenszwalb graph segmentation on the multi-date HH+HV stack (20 m multilook, dB).
Pixels that change together over the season end up in one segment, which follows
real field edges far better than a square grid. Keeps segments that are >= 0.5 ha
and >= 50% WorldCover cropland.
Output: data/segments_<tile>.npz  labels (int32, 20 m grid, 0 = not a field), ids, area_ha, crop_frac
"""
import glob, json, os
import numpy as np
from scipy.ndimage import uniform_filter
from skimage.segmentation import felzenszwalb

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
ML = 2            # 10 m -> 20 m
REF_TRACK = 84
SCALE, SIGMA, MIN_PX = 6.0, 0.6, 13   # 13 px * 400 m2 = 0.52 ha


def ml(a, k=ML):
    R, C = a.shape[0] // k, a.shape[1] // k
    return a[:R * k, :C * k].reshape(R, k, C, k).mean((1, 3))


def main():
    # one track only so every channel shares the same grid and viewing geometry
    used = {p["pass_id"] for p in json.load(open(os.path.join(ART, "passes.json")))["passes"]
            if p["used"] and p["track"] == REF_TRACK}
    tiles = sorted({os.path.basename(p)[:-4].split("_", 1)[1] for p in glob.glob("data/p2026*_*.npz")})
    if os.environ.get("ONLY_TILE"):
        tiles = [os.environ["ONLY_TILE"]]
    for tile in tiles:
        chans = []
        for path in sorted(glob.glob(f"data/p2026*_{tile}.npz")):  # NOTE: track 084 grid only
            if os.path.basename(path).split("_")[0] not in used:
                continue
            d = np.load(path)
            for k in ("HHHH", "HVHV"):
                a = uniform_filter(ml(np.nan_to_num(d[k].astype("f8"), nan=1e-4)), 3)  # tame speckle
                chans.append(10 * np.log10(np.clip(a, 1e-4, None)) / 3.0)
        img = np.stack(chans, -1)
        seg = felzenszwalb(img, scale=SCALE, sigma=SIGMA, min_size=MIN_PX, channel_axis=-1) + 1
        crop = ml(np.load(f"data/landcover_{tile}.npz")["crop"].astype("f8"))
        n = seg.max() + 1
        area = np.bincount(seg.ravel(), minlength=n)
        cfrac = np.bincount(seg.ravel(), weights=crop.ravel(), minlength=n) / np.maximum(area, 1)
        keep = (area >= MIN_PX) & (cfrac >= 0.5) & (area <= 2500)  # > 100 ha is not one field
        keep[0] = False
        remap = np.zeros(n, dtype=np.int32)
        remap[keep] = np.arange(1, keep.sum() + 1)
        labels = remap[seg]
        np.savez_compressed(f"data/segments_{tile}.npz", labels=labels, ml=ML,
                            area_ha=area[keep] * 0.04, crop_frac=cfrac[keep])
        a = area[keep] * 0.04
        print(tile, f"{keep.sum()} segments, area ha median {np.median(a):.1f} (p10 {np.percentile(a, 10):.1f}, "
              f"p90 {np.percentile(a, 90):.1f}), covers {100 * (labels > 0).mean():.0f}% of tile")


if __name__ == "__main__":
    main()
