"""Area-weighted rice fraction on the native pixel grid (geo/rice.py)."""
import numpy as np
import pytest
import shapely
import shapely.affinity

from conftest import RES, write_raster
from rice import RiceMask, globalrice20_is_rice, rice_fractions, zhao_is_rice

LEFT, TOP = 74.0, 30.01


@pytest.fixture
def checker(tmp_path):
    """10 x 10 pixels: rice in the left 4 columns, plus pixel (row 9, col 9)."""
    arr = np.zeros((10, 10), dtype=np.uint8)
    arr[:, :4] = 1
    arr[9, 9] = 1
    return write_raster(tmp_path / "m.tif", arr, LEFT, TOP)


def px(c0, r0, c1, r1):
    """Box covering pixel columns c0..c1 and rows r0..r1 (fractional allowed)."""
    return shapely.box(LEFT + c0 * RES, TOP - r1 * RES, LEFT + c1 * RES, TOP - r0 * RES)


def mask_for(path, geoms, classify=globalrice20_is_rice):
    return RiceMask(path, tuple(shapely.total_bounds(np.asarray(geoms, dtype=object))), classify)


def test_pixel_aligned_boxes_are_exact(checker):
    geoms = [px(0, 0, 4, 10), px(4, 0, 8, 10), px(2, 0, 6, 10), px(9, 9, 10, 10)]
    frac = rice_fractions(geoms, mask_for(checker, geoms))
    np.testing.assert_allclose(frac, [1.0, 0.0, 0.5, 1.0], atol=1e-9)  # float roundoff only


def test_partial_pixels_are_area_weighted(checker):
    geoms = [px(3.5, 0, 4.5, 1), px(3.75, 2, 4.0, 3), px(3.9, 2, 4.4, 3)]
    frac = rice_fractions(geoms, mask_for(checker, geoms))
    np.testing.assert_allclose(frac, [0.5, 1.0, 0.2], atol=1e-9)


def test_holes_are_excluded(checker):
    outer = px(0, 0, 8, 4)
    hole = px(0.5, 1, 3.5, 3)  # entirely on rice
    geom = shapely.Polygon(outer.exterior.coords, [hole.exterior.coords])
    frac = rice_fractions([geom], mask_for(checker, [geom]))[0]
    rice_area = 4 * 4 - 3 * 2  # pixels of rice in the outer box minus the hole
    assert frac == pytest.approx(rice_area / (32 - 6), abs=1e-9)


def test_outside_the_raster_is_not_rice(checker):
    geom = px(-4, 0, 4, 10)  # half west of the raster
    assert rice_fractions([geom], mask_for(checker, [geom]))[0] == pytest.approx(0.5)


def test_rotated_polygon_matches_brute_force(checker):
    geom = shapely.affinity.rotate(px(1, 1, 7, 7), 30, origin="centroid")
    frac = rice_fractions([geom], mask_for(checker, [geom]))[0]
    # brute force: 400 x 400 sub-samples per pixel grid
    xs = LEFT + (np.arange(4000) + 0.5) * RES / 400
    ys = TOP - (np.arange(4000) + 0.5) * RES / 400
    X, Y = np.meshgrid(xs, ys)
    inside = shapely.contains_xy(geom, X, Y)
    cols, rows = ((X - LEFT) / RES).astype(int), ((TOP - Y) / RES).astype(int)
    arr = np.zeros((10, 10), bool)
    arr[:, :4] = True
    arr[9, 9] = True
    expected = (inside & arr[rows, cols]).sum() / inside.sum()
    assert frac == pytest.approx(expected, abs=2e-3)


def test_many_polygons_in_small_batches(checker):
    geoms = [px(i * 0.5, 0, i * 0.5 + 1, 1) for i in range(18)]
    m = mask_for(checker, geoms)
    np.testing.assert_allclose(rice_fractions(geoms, m, batch=3), rice_fractions(geoms, m), atol=1e-12)


def test_classifiers():
    a = np.array([0, 1, 2, 3, 4, 255], dtype=np.uint8)
    assert globalrice20_is_rice(a).tolist() == [False, True, False, False, False, False]
    assert zhao_is_rice(a).tolist() == [False, True, True, True, False, False]


def test_empty_input(checker):
    assert len(rice_fractions([], RiceMask(checker, (LEFT, TOP - 0.001, LEFT + 0.001, TOP), globalrice20_is_rice))) == 0
