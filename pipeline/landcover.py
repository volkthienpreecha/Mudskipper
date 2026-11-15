"""Cropland mask per tile from ESA WorldCover 2021 v200 (10 m, CC BY 4.0).

Stop-gap until geo/ provides rice_mask_frac (Han et al. rice mask) in fields.geojson.
WorldCover class 40 = cropland; everything else (built-up 50, trees 10, water 80, ...)
is excluded from field statistics so towns/roads cannot drive the classifier.
Output: data/landcover_<tile>.npz with `crop` (bool) on the same 10 m UTM grid as the
dual-pol tile subsets, plus class shares printed.
"""
import glob, os
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
from rasterio.windows import from_bounds
from pyproj import Transformer

URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E072_Map.tif"
NAMES = {10: "trees", 20: "shrub", 30: "grass", 40: "cropland", 50: "built-up", 60: "bare", 80: "water", 90: "wetland"}


def main():
    tiles = sorted({os.path.basename(p)[:-4].split("_", 1)[1] for p in glob.glob("data/p2026*_*.npz")})
    if os.environ.get("ONLY_TILE"):
        tiles = [os.environ["ONLY_TILE"]]
    with rasterio.open(URL) as src:
        for tile in tiles:
            d = np.load(f"data/p20260702_{tile}.npz")  # reference grid = zonal.REF_PASS (track 084)
            x, y, epsg = d["x"], d["y"], int(d["epsg"])
            dst_tr = from_origin(x[0] - 5, y[0] + 5, 10, 10)
            tr = Transformer.from_crs(epsg, 4326, always_xy=True)
            lon, lat = tr.transform([x[0], x[-1], x[0], x[-1]], [y[0], y[0], y[-1], y[-1]])
            win = from_bounds(min(lon) - 0.01, min(lat) - 0.01, max(lon) + 0.01, max(lat) + 0.01, src.transform)
            lc = src.read(1, window=win)
            out = np.zeros((len(y), len(x)), dtype=np.uint8)
            reproject(lc, out, src_transform=src.window_transform(win), src_crs=src.crs,
                      dst_transform=dst_tr, dst_crs=f"EPSG:{epsg}", resampling=Resampling.nearest)
            np.savez_compressed(f"data/landcover_{tile}.npz", lc=out, crop=out == 40, x=x, y=y, epsg=epsg,
                                source="ESA WorldCover 10m 2021 v200")
            v, n = np.unique(out, return_counts=True)
            print(tile, {NAMES.get(int(a), int(a)): f"{100 * b / out.size:.1f}%" for a, b in zip(v, n)})


if __name__ == "__main__":
    main()
