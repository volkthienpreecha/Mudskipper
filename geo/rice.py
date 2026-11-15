"""Area-weighted rice fraction of polygons, computed on a rice mask's native pixel grid.

`rice_fractions(geoms, raster)` returns, for each lon/lat polygon, the share of its area that lies on rice pixels:

    frac = sum over rice pixels p of area(polygon ∩ p) / area(polygon)

Pixels are the raster's own cells (GlobalRice20: 0.00017966° ≈ 20 m, EPSG:4326), so nothing is resampled. Areas are
planar in degrees; across one field (≤ a few hundred metres) the metres-per-degree scale changes by less than
1e-5 relative, so the ratio equals the UTM-area ratio to that precision. Pixels outside the raster count as not
rice. Pixels fully inside a polygon are counted whole (prepared contains_properly); only edge pixels are
intersected.
"""
from __future__ import annotations

import math
import pathlib
from typing import Callable

import numpy as np
import rasterio
import shapely
from rasterio.windows import Window

Classifier = Callable[[np.ndarray], np.ndarray]


def globalrice20_is_rice(a: np.ndarray) -> np.ndarray:
    """GlobalRice20: 1 = paddy rice; 0 = other (the file declares 0 as nodata, but it means 'not rice')."""
    return a == 1


def zhao_is_rice(a: np.ndarray) -> np.ndarray:
    """Zhao et al. 2024: 0 = not rice; 1, 2, 3 = rice cropped once, twice, three times a year."""
    return (a >= 1) & (a <= 3)


class RiceMask:
    """A window of a rice raster, read once, with its pixel grid."""

    def __init__(self, path: pathlib.Path | str, bounds: tuple[float, float, float, float], classify: Classifier,
                 pad: int = 2):
        with rasterio.open(path) as ds:
            t = ds.transform
            if t.b != 0 or t.d != 0:
                raise ValueError("rotated rasters are not supported")
            self.res_x, self.res_y = t.a, -t.e  # res_y > 0 for north-up rasters
            minx, miny, maxx, maxy = bounds
            c0 = math.floor((minx - t.c) / self.res_x) - pad
            c1 = math.floor((maxx - t.c) / self.res_x) + pad
            r0 = math.floor((t.f - maxy) / self.res_y) - pad
            r1 = math.floor((t.f - miny) / self.res_y) + pad
            win = Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)
            raw = ds.read(1, window=win, boundless=True, fill_value=0, masked=False)
            self.left, self.top = t.c, t.f
        self.c0, self.r0 = c0, r0
        self.rice = classify(raw)

    def pixel_index(self, x, y):
        c = np.floor((np.asarray(x) - self.left) / self.res_x).astype(np.int64)
        r = np.floor((self.top - np.asarray(y)) / self.res_y).astype(np.int64)
        return c, r

    def share(self) -> float:
        """Rice share of every pixel in the window (used for quick summaries)."""
        return float(self.rice.mean())


def rice_fractions(geoms, mask: RiceMask, batch: int = 2_000_000) -> np.ndarray:
    geoms = np.asarray(geoms, dtype=object)
    n = len(geoms)
    out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return out
    b = shapely.bounds(geoms)
    c0, r1 = mask.pixel_index(b[:, 0], b[:, 1])
    c1, r0 = mask.pixel_index(b[:, 2], b[:, 3])
    nc, nr = c1 - c0 + 1, r1 - r0 + 1
    counts = nc * nr
    shapely.prepare(geoms)
    areas = shapely.area(geoms)
    rice_area = np.zeros(n, dtype=np.float64)
    # walk geometries in groups whose pixel pairs fit in one batch
    start = 0
    cum = np.cumsum(counts)
    while start < n:
        base = cum[start - 1] if start else 0
        stop = int(np.searchsorted(cum, base + batch, side="right"))
        stop = max(stop, start + 1)
        sel = np.arange(start, stop)
        cnt = counts[sel]
        idx = np.repeat(sel, cnt)
        offs = np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        dc = offs % nc[idx]
        dr = offs // nc[idx]
        c = c0[idx] + dc
        r = r0[idx] + dr
        lr, lc = r - mask.r0, c - mask.c0
        inside = (lr >= 0) & (lr < mask.rice.shape[0]) & (lc >= 0) & (lc < mask.rice.shape[1])
        is_rice = np.zeros(len(idx), dtype=bool)
        is_rice[inside] = mask.rice[lr[inside], lc[inside]]
        idx, c, r = idx[is_rice], c[is_rice], r[is_rice]
        if len(idx):
            x0 = mask.left + c * mask.res_x
            y1 = mask.top - r * mask.res_y
            boxes = shapely.box(x0, y1 - mask.res_y, x0 + mask.res_x, y1)
            full = shapely.contains_properly(geoms[idx], boxes)
            a = np.where(full, mask.res_x * mask.res_y, 0.0)
            part = ~full
            if part.any():
                a[part] = shapely.area(shapely.intersection(geoms[idx[part]], boxes[part]))
            rice_area += np.bincount(idx, weights=a, minlength=n)
        start = stop
    np.divide(rice_area, areas, out=out, where=areas > 0)
    return np.clip(out, 0.0, 1.0)
