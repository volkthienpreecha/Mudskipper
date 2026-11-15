"""The FTW filter chain (geo/fields.py) on synthetic polygons: clip, repair, area, rice, cap, ids, labels."""
import geopandas as gpd
import pytest
import shapely

import common as c
import fields
import output
from common import rules


def utm_poly_ll(x0, y0, w, h):
    return c.to_lonlat(shapely.box(x0, y0, x0 + w, y0 + h))


@pytest.fixture
def synthetic(small_tiles):
    """Polygons around tile alpha (x 445500-446500, y 3345500-3346500; rice west of x = 446000)."""
    t = small_tiles[0]
    rows = [
        ("big-rice", utm_poly_ll(445_600, 3_345_600, 100, 80)),         # 0.8 ha, all rice: kept
        ("small-rice", utm_poly_ll(445_600, 3_345_800, 60, 60)),        # 0.36 ha: removed by area
        ("big-dry", utm_poly_ll(446_100, 3_345_600, 100, 80)),          # 0.8 ha, no rice: removed by rice
        ("half", utm_poly_ll(445_950, 3_346_000, 100, 100)),            # 1 ha, 50% rice: kept (>= 0.5)
        ("outside", utm_poly_ll(444_000, 3_345_600, 100, 100)),         # west of the tile: removed outside
        ("edge", utm_poly_ll(445_450, 3_346_200, 150, 100)),            # crosses the west edge: clipped to 1 ha
        ("u-shape", c.to_lonlat(shapely.Polygon([(445_600, 3_346_300), (445_800, 3_346_300), (445_800, 3_346_450),
                                                (445_750, 3_346_450), (445_750, 3_346_350), (445_650, 3_346_350),
                                                (445_650, 3_346_450), (445_600, 3_346_450)]))),
        ("bowtie", c.to_lonlat(shapely.Polygon([(445_650, 3_345_880), (445_850, 3_345_980), (445_850, 3_345_880),
                                               (445_650, 3_345_980)]))),  # invalid: repaired into 2 x 0.5 ha
    ]
    gdf = gpd.GeoDataFrame({"id": [r[0] for r in rows]}, geometry=[r[1] for r in rows], crs="EPSG:4326")
    return t, gdf


def by_geom_type(out):
    return {x["id"]: x["geom"].geom_type for x in out}


def test_filter_chain_counts(synthetic, half_rice_raster):
    t, gdf = synthetic
    path, _ = half_rice_raster
    out, counts = fields.candidates(t, gdf, path)
    assert counts["in_bbox"] == 8
    assert counts["repaired_invalid"] == 1
    assert counts["removed_outside_tile"] == 1
    assert counts["removed_lt_0.5ha"] == 1  # small-rice
    assert counts["removed_rice_lt_0.5"] == 1
    kept = {x["id"] for x in out}
    assert kept == {"big-rice", "half", "edge", "u-shape", "bowtie"}
    assert by_geom_type(out)["bowtie"] == "MultiPolygon"
    by_id = {x["id"]: x for x in out}
    assert 0.5 <= by_id["half"]["rice"] <= 0.6  # the split is a meridian; UTM x = 446000 is not
    assert c.area_ha_utm(by_id["edge"]["geom"]) == pytest.approx(1.0, abs=1e-3)  # 50 m of 150 m was outside


def test_select_ids_labels_and_cap(synthetic, half_rice_raster, small_tiles):
    t, gdf = synthetic
    path, _ = half_rice_raster
    out, _ = fields.candidates(t, gdf, path)
    feats, removed = fields.select(small_tiles, {"alpha": out, "beta": []}, "ftw-global")
    assert [f["properties"]["field_id"] for f in feats] == [f"alpha-{i:05d}" for i in range(1, 6)]
    assert removed == {"alpha": 0, "beta": 0}
    for f in feats:
        p = f["properties"]
        assert p["source"] == "ftw" and p["area_ha"] >= 0.5 and 0.5 <= p["rice_mask_frac"] <= 1
        assert rules.contains(f["geometry"], p["lon"], p["lat"])  # u-shape: the centroid is outside
    # reading order: 500 m bands from the north, west to east inside a band
    keys = [output.spatial_order_key(t, f["properties"]["lon"], f["properties"]["lat"], "") for f in feats]
    assert keys == sorted(keys)
    assert [k[0] for k in keys] == [0, 0, 0, 1, 1]


def test_cap_is_seeded_and_independent_of_input_order(synthetic, half_rice_raster, small_tiles):
    t, gdf = synthetic
    path, _ = half_rice_raster
    out, _ = fields.candidates(t, gdf, path)
    a, removed = fields.select(small_tiles, {"alpha": out, "beta": []}, "ftw-global", max_fields=2)
    b, _ = fields.select(small_tiles, {"alpha": list(reversed(out)), "beta": []}, "ftw-global", max_fields=2)
    assert removed["alpha"] == 3 and len(a) == 2
    assert a == b
    seeds = {tuple(f["properties"]["lon"] for f in fields.select(small_tiles, {"alpha": out, "beta": []},
                                                                    "ftw-global", max_fields=2, seed=s)[0])
             for s in range(8)}
    assert len(seeds) > 1


def test_rerun_is_identical(synthetic, half_rice_raster, small_tiles):
    t, gdf = synthetic
    path, _ = half_rice_raster
    runs = []
    for _ in range(2):
        out, counts = fields.candidates(t, gdf, path)
        runs.append((fields.select(small_tiles, {"alpha": out, "beta": []}, "ftw-global")[0], counts))
    assert runs[0] == runs[1]


def test_bbox_key_is_stable():
    assert fields.bbox_key([74.1, 30.2, 74.3, 30.4]) == fields.bbox_key([74.1, 30.2, 74.3, 30.4])
    assert fields.bbox_key([74.1, 30.2, 74.3, 30.4]) != fields.bbox_key([74.1, 30.2, 74.3, 30.5])
