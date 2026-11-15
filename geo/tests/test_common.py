"""Shared helpers: tiles, rounding, label points, quotas, writers (geo/common.py)."""
import json
import pathlib

import numpy as np
import pytest
import shapely

import common as c
from common import rules


def test_official_tiles_are_the_pipelines():
    """K-117: geo/tiles.json holds the radar pipeline's tiles as 15 km UTM squares inside its boxes."""
    doc = json.loads((c.GEO_DIR / "tiles.json").read_text(encoding="utf-8"))
    tiles = c.load_tiles()
    assert [t.id for t in tiles] == ["fazilka", "muktsar"]
    assert [t.district for t in tiles] == ["Fazilka", "Sri Muktsar Sahib"]
    for t, d in zip(tiles, doc["tiles"]):
        assert t.x0 % c.SNAP_M == 0 and t.y0 % c.SNAP_M == 0
        assert t.size == 15_000
        assert t.bbox == d["bbox"]
        box = d["pipeline_box"]
        assert box[0] <= d["center_lonlat"][0] <= box[2] and box[1] <= d["center_lonlat"][1] <= box[3]
        assert d["inside_district"] >= 0.98


def test_rice_dense_alternative_obeys_the_search_rules():
    doc = json.loads((c.GEO_DIR / "tiles.rice-dense.json").read_text(encoding="utf-8"))
    tiles = c.load_tiles(c.GEO_DIR / "tiles.rice-dense.json")
    assert [t.id for t in tiles] == ["fazilka", "muktsar"]
    for t, d in zip(tiles, doc["tiles"]):
        assert t.x0 % c.SNAP_M == 0 and t.y0 % c.SNAP_M == 0 and t.size == 15_000
        assert t.bbox == d["bbox"]
        assert d["rice_share"]["globalrice20_2024"] >= 0.5 and d["rice_share"]["zhao_2024"] >= 0.5
    assert {(f["track"], f["direction"], f["frame"]) for f in doc["frames"]} == {(135, "descending", 73), (84, "ascending", 17)}


def test_lonlat_bbox_contains_the_utm_square():
    t = c.Tile("x", "X", 445_500.0, 3_345_500.0)
    b = t.bbox
    xs = np.linspace(t.x0, t.x0 + t.size, 301)
    for x, y in [(x, t.y0) for x in xs] + [(x, t.y0 + t.size) for x in xs]:
        lon, lat = c.TO_LL.transform(x, y)
        assert b[0] <= lon <= b[2] and b[1] <= lat <= b[3]
    assert all(round(v, 6) == v for v in b)


def test_snap():
    assert c.snap(445_519.9) == 445_500.0
    assert c.snap(445_520.0) == 445_520.0


@pytest.mark.parametrize("total,avail,expected", [
    (5000, {"a": 4000, "b": 4000}, {"a": 2500, "b": 2500}),
    (5000, {"a": 1000, "b": 9000}, {"a": 1000, "b": 4000}),
    (5000, {"a": 100, "b": 200}, {"a": 100, "b": 200}),
    (5, {"a": 9, "b": 9}, {"a": 3, "b": 2}),
    (5000, {"a": 0, "b": 0}, {"a": 0, "b": 0}),
])
def test_quotas(total, avail, expected):
    assert c.quotas(avail, total) == expected


def test_hash_rank_is_stable():
    assert c.hash_rank(20261114, "grid|fazilka|000|001") == c.hash_rank(20261114, "grid|fazilka|000|001")
    assert c.hash_rank(1, "k") != c.hash_rank(2, "k")
    # pinned value: the selection must never change with Python, NumPy or platform
    assert c.hash_rank(20261114, "x") == "d75b513071a67e463a465b4443aa9be8f473377547b6e913a8df958ca73e4014"  # printf "20261114|x" | shasum -a 256


def test_round_geom_keeps_validity_and_orients_rings():
    outer = shapely.box(74.0, 30.0, 74.001, 30.001)
    hole = shapely.box(74.0004, 30.0004, 74.0006, 30.0006)
    g = c.round_geom(shapely.Polygon(outer.exterior.coords[::-1], [hole.exterior.coords]))
    assert g.is_valid
    assert g.exterior.is_ccw and not g.interiors[0].is_ccw
    gj = c.geometry_json(g)
    for ring in gj["coordinates"]:
        assert ring[0] == ring[-1] and len(ring) >= 4
        assert all(round(v, 7) == v for p in ring for v in p)


def test_round_geom_repairs_a_bowtie():
    bowtie = shapely.Polygon([(74.0, 30.0), (74.001, 30.001), (74.001, 30.0), (74.0, 30.001)])
    assert not bowtie.is_valid
    g = c.round_geom(shapely.make_valid(bowtie))
    assert g is not None and g.is_valid and g.geom_type == "MultiPolygon"


def test_polygonal_drops_lines_and_points():
    gc = shapely.GeometryCollection([shapely.box(0, 0, 1, 1), shapely.LineString([(0, 0), (2, 2)]), shapely.Point(5, 5)])
    assert c.polygonal(gc).geom_type == "Polygon"
    assert c.polygonal(shapely.LineString([(0, 0), (1, 1)])) is None


@pytest.mark.parametrize("geom", [
    shapely.Polygon([(74.0, 30.0), (74.003, 30.0), (74.003, 30.003), (74.002, 30.003), (74.002, 30.001),
                     (74.001, 30.001), (74.001, 30.003), (74.0, 30.003)]),  # U shape: the centroid is outside
    shapely.box(74.0, 30.0, 74.003, 30.0000004),  # a 4 cm sliver
    shapely.MultiPolygon([shapely.box(74.0, 30.0, 74.0001, 30.0001), shapely.box(74.01, 30.0, 74.02, 30.01)]),
])
def test_label_point_is_inside_by_the_contract_test(geom):
    g = c.round_geom(geom)
    gj = c.geometry_json(g)
    lon, lat = c.label_point(gj, g)
    assert rules.contains(gj, lon, lat)
    assert round(lon, 7) == lon and round(lat, 7) == lat


def test_area_is_computed_in_utm():
    sq = c.to_lonlat(shapely.box(445_500, 3_345_500, 445_600, 3_345_600))
    assert c.area_ha_utm(sq) == pytest.approx(1.0, abs=1e-9)


def test_dump_collection_layout(tmp_path):
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 2]}, "properties": {"a": i}} for i in range(3)]
    text = c.dump_collection({"v": 1, "run_id": "r01", "type": "FeatureCollection"}, feats)
    assert text.endswith("\n]}\n") and "\r" not in text
    lines = text.splitlines()
    assert len(lines) == 5 and lines[0] == '{"v":1,"run_id":"r01","type":"FeatureCollection","features":['
    assert json.loads(text)["features"] == feats
    c.write_text(tmp_path / "x.geojson", text)
    assert (tmp_path / "x.geojson").read_bytes() == text.encode("utf-8")
    with pytest.raises(ValueError):
        c.dump({"x": float("nan")})


def test_data_and_run_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("MUDSKIPPER_DATA_DIR", str(tmp_path / "d"))
    monkeypatch.delenv("MUDSKIPPER_RUN_DIR", raising=False)
    assert c.data_dir() == (tmp_path / "d").resolve()
    assert c.data_dir(tmp_path / "e") == (tmp_path / "e").resolve()
    assert c.run_dir(None, "r07") == (c.REPO / "artifacts" / "r07").resolve()
    assert isinstance(c.run_dir(), pathlib.Path)
