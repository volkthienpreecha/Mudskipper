"""Rice prior per field from a published rice map (independent of all 2026 validation data).

Map: "Mapping Paddy Rice Distribution and Cropping Intensity in South and Southeast Asia (1995-2024) at 30 m",
Zenodo doi:10.5281/zenodo.21349862, CC-BY-4.0, file "India North 2024.tif" (Rice-Sentinel algorithm, Zhao et al.
2024 RSE 315:114460; reported overall accuracy 84-88%). Values: 0 not rice, 1 single rice, 2 double rice.
Only the tile windows are read (HTTP range requests); the 53 MB file is not downloaded.
Per field: rice_frac_2024 = share of the field's 10 m pixels whose map cell is rice (nearest 30 m cell).
Punjab paddy is a stable rice-wheat rotation, so 2024 rice land is a strong prior for 2026; cotton land
(mostly Fazilka) is 0 in the map.
Output: data/rice2024_<tile>.npz {labels index -> rice_frac}, artifacts/<run>/rice_prior.jsonl
"""
import json, os
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from affine import Affine
from zonal import REF_PASS, on_grid, field_id

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
TILES = os.environ.get("TILES", "fazilka,muktsar").split(",")
URL = "/vsicurl/https://zenodo.org/api/records/21349862/files/India%20North%202024.tif/content"
ENV = dict(GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,/content",
           GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR")


def main():
    out = open(os.path.join(ART, "rice_prior.jsonl"), "w")
    with rasterio.Env(**ENV), rasterio.open(URL) as src:
        for tile in TILES:
            ref = np.load(f"data/{REF_PASS}_{tile}.npz"); seg = np.load(f"data/segments_{tile}.npz")
            x, y = ref["x"], ref["y"]; H, W = len(y), len(x)
            tf = Affine(10, 0, x[0] - 5, 0, -10, y[0] + 5)
            from rasterio.warp import transform_bounds
            b = transform_bounds(f"EPSG:{int(ref['epsg'])}", src.crs, x[0] - 5, y[-1] - 5, x[-1] + 5, y[0] + 5)
            win = rasterio.windows.from_bounds(*b, src.transform).round_offsets().round_lengths()
            a = src.read(1, window=win)
            rice = np.zeros((H, W), np.uint8)
            reproject((a >= 1).astype(np.uint8), rice, src_transform=src.window_transform(win), src_crs=src.crs,
                      dst_transform=tf, dst_crs=f"EPSG:{int(ref['epsg'])}", resampling=Resampling.nearest)
            lab = on_grid(seg["labels"], 10 * int(seg["ml"]), x[0] - 5, y[0] + 5, x, y)
            nl = int(seg["labels"].max()) + 1
            n = np.bincount(lab[lab > 0], minlength=nl)
            r = np.bincount(lab[lab > 0], weights=rice[lab > 0], minlength=nl)
            frac = np.where(n > 0, r / np.maximum(n, 1), np.nan)
            np.savez_compressed(f"data/rice2024_{tile}.npz", rice_frac=frac)
            for i in np.nonzero(n > 0)[0]:
                out.write(json.dumps({"field_id": field_id(tile, int(i)), "tile": tile,
                                      "rice_frac_2024": round(float(frac[i]), 3)}) + "\n")
            print(tile, "fields", int((n > 0).sum()), "rice-majority", int((frac >= 0.5).sum()), flush=True)
    out.close()


if __name__ == "__main__":
    main()
