"""The labeled grid (geo/grid.py): alignment, areas, rice filter, cap, ids."""
import pytest
import shapely

import common as c
import grid
from common import rules


def test_cells_are_aligned_one_hectare_squares(small_tiles):
    t = small_tiles[0]
    rows, cols, polys = grid.grid_cells(t)
    assert len(polys) == 100 and rows.max() == 9 and cols.max() == 9
    for r, k, p in zip(rows, cols, polys):
        utm = c.to_utm(p)
        x0, y0, x1, y1 = shapely.bounds(utm)
        # corners sit on the 100 m lattice anchored at the 20 m-snapped origin (to ~1 cm after 1e-7° rounding)
        assert x0 == pytest.approx(t.x0 + k * 100, abs=0.02)
        assert y1 == pytest.approx(t.y0 + t.size - r * 100, abs=0.02)
        assert x1 - x0 == pytest.approx(100, abs=0.03) and y1 - y0 == pytest.approx(100, abs=0.03)
        assert c.area_ha_utm(p) == pytest.approx(1.0, abs=5e-4)
    # each 100 m cell is exactly 5 x 5 pixels of 20 m, 10 x 10 of 10 m
    assert (t.x0 % 20, t.y0 % 20, c.CELL_M % 20, c.CELL_M % 10) == (0, 0, 0, 0)


def test_neighbouring_cells_share_edges_exactly(small_tiles):
    _, _, polys = grid.grid_cells(small_tiles[0])
    a, b = polys[0], polys[1]
    shared = shapely.intersection(a.boundary, b.boundary)
    assert shared.length > 0 and shapely.area(shapely.intersection(a, b)) == 0


def test_build_filters_caps_and_numbers(small_tiles, half_rice_raster):
    path, split = half_rice_raster
    feats, stats = grid.build(small_tiles, path, max_fields=1000)
    # tile alpha spans x 445500-446500 and rice lies west of x=446000: 5 rice columns, about 50 cells
    assert 40 <= stats["alpha"]["rice_ge_0.5"] <= 60
    assert stats["beta"]["rice_ge_0.5"] == 0
    ids = [f["properties"]["field_id"] for f in feats]
    assert ids == [f"alpha-{i:05d}" for i in range(1, len(ids) + 1)]
    for f in feats:
        p = f["properties"]
        assert p["source"] == "grid" and p["rice_mask_frac"] >= 0.5 and p["area_ha"] >= 0.5
        assert p["lon"] < split + 0.002
        assert rules.contains(f["geometry"], p["lon"], p["lat"])
    # ids run row by row from the north-west corner: the first five share a row, west to east
    first = [f["properties"] for f in feats[:5]]
    assert all(abs(p["lat"] - first[0]["lat"]) < 2e-5 for p in first)  # rows are 9e-4° apart; UTM convergence tilts them
    assert [p["lon"] for p in first] == sorted(p["lon"] for p in first)


def test_cap_is_deterministic_and_seeded(small_tiles, half_rice_raster):
    path, _ = half_rice_raster
    a, _ = grid.build(small_tiles, path, max_fields=10)
    b, _ = grid.build(small_tiles, path, max_fields=10)
    other, _ = grid.build(small_tiles, path, max_fields=10, seed=7)
    assert len(a) == 10
    assert a == b
    assert [f["geometry"] for f in a] != [f["geometry"] for f in other]
    # all quota goes to alpha because beta has no rice cells
    assert {f["properties"]["tile"] for f in a} == {"alpha"}


def test_cap_never_exceeds_5000(small_tiles, half_rice_raster):
    path, _ = half_rice_raster
    feats, _ = grid.build(small_tiles, path)
    assert len(feats) <= c.MAX_FIELDS
