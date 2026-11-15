"""Shared fixtures: small synthetic rice rasters and tiles. No test touches the network."""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

GEO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GEO))

import common as c  # noqa: E402

RES = 0.0002  # degrees, about 20 m


def write_raster(path: pathlib.Path, arr: np.ndarray, left: float, top: float, res: float = RES, nodata=0) -> pathlib.Path:
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1,
                       dtype=arr.dtype, crs="EPSG:4326", transform=from_origin(left, top, res, res),
                       nodata=nodata) as ds:
        ds.write(arr, 1)
    return path


@pytest.fixture
def small_tiles():
    """Two 1 km tiles (100 cells each) at the real UTM location of the Muktsar tile."""
    return [c.Tile("alpha", "Fazilka", 445_500.0, 3_345_500.0, 1_000.0),
            c.Tile("beta", "Sri Muktsar Sahib", 447_000.0, 3_345_500.0, 1_000.0)]


@pytest.fixture
def half_rice_raster(tmp_path, small_tiles):
    """GlobalRice20-style mask (1 = rice) covering both small tiles: rice west of the split longitude."""
    lon0, lat0 = c.TO_LL.transform(445_000.0, 3_347_000.0)
    lon1, lat1 = c.TO_LL.transform(448_500.0, 3_345_000.0)
    left, top = np.floor(lon0 / RES) * RES, np.ceil(lat0 / RES) * RES
    w, h = int((lon1 - left) / RES) + 2, int((top - lat1) / RES) + 2
    lons = left + (np.arange(w) + 0.5) * RES
    split, _ = c.TO_LL.transform(446_000.0, 3_346_000.0)
    arr = np.broadcast_to((lons < split).astype(np.uint8), (h, w)).copy()
    return write_raster(tmp_path / "rice.tif", arr, left, top), split
