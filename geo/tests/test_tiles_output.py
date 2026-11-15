"""Tile search math (geo/tiles.py) and the run writer (geo/output.py), checked by contracts/validate.py."""
import json

import numpy as np
import pytest
import shapely

import common as c
import grid
import output
import tiles
from common import REPO

import sys

sys.path.insert(0, str(REPO / "contracts"))
import validate  # noqa: E402

SCHEMAS = validate.Schemas()


def test_window_shares_match_brute_force():
    rng = np.random.default_rng(0)
    mask = (rng.random((60, 80)) < 0.4).astype(np.uint8)
    gx0, gy1, size = 1000.0, 5000.0, 400.0  # 20 m pixels: windows of 20 x 20 pixels
    x0s = np.array([1000.0, 1100.0, 1580.0, 1200.0])
    y0s = np.array([3800.0, 4000.0, 4600.0, 3900.0])
    got = tiles.window_shares(mask, gx0, gy1, x0s, y0s, size)
    for g, x0, y0 in zip(got, x0s, y0s):
        c0, r0 = int((x0 - gx0) / 20), int((gy1 - (y0 + size)) / 20)
        assert g == pytest.approx(mask[r0:r0 + 20, c0:c0 + 20].mean())


def test_frame_core_is_the_intersection_of_every_footprint():
    def feat(poly, track=135, frame=73, name="g"):
        return {"geometry": shapely.geometry.mapping(poly),
                "properties": {"pathNumber": track, "frameNumber": frame, "sceneName": name}}
    doc = {"features": [feat(shapely.box(0, 0, 10, 10), name="a"), feat(shapely.box(2, 1, 12, 10), name="b"),
                        feat(shapely.box(50, 50, 60, 60), track=84, name="other")]}
    core, ids = tiles.frame_core(doc, 135, 73)
    assert core.equals(shapely.box(2, 1, 10, 10))
    assert ids == ["a", "b"]
    with pytest.raises(SystemExit):
        tiles.frame_core(doc, 135, 74)


def test_tile_polygon_is_densified_and_inside_bbox():
    t = c.Tile("x", "X", 445_500.0, 3_345_500.0)
    poly = tiles.tile_polygon_lonlat(t.utm_bounds)
    assert len(poly.exterior.coords) > 500
    b = t.bbox
    assert shapely.box(*b).contains(poly)
    assert c.area_ha_utm(poly) == pytest.approx(22_500, rel=1e-6)


def test_aoi_doc_is_valid_and_carries_the_gap(small_tiles):
    doc = output.aoi_doc("r01", small_tiles)
    assert SCHEMAS.errors("aoi", doc) == []
    assert list(doc) == ["v", "run_id", "tiles", "utm_epsg", "season", "stages", "gaps"]
    assert doc["gaps"] == [{"start": "2026-07-27T22:03:25Z", "end": "2026-08-10T00:55:27Z",
                            "source": "https://nisar-docs.asf.alaska.edu/availability-overview/"}]
    assert doc["utm_epsg"] == 32643


def test_grid_run_passes_the_validator_and_pmtiles_round_trips(tmp_path, small_tiles, half_rice_raster):
    path, _ = half_rice_raster
    feats, _ = grid.build(small_tiles, path)
    run = tmp_path / "r99"
    info = output.write_run(run, "r99", small_tiles, feats)
    assert info["pmtiles"]["fields_z16"] == len(feats) and info["pmtiles"]["layer"] == "fields"
    assert (run / "fields.pmtiles").read_bytes()[:8] == b"PMTiles\x03"
    rep = validate.Report("geo")
    validate.validate_run(run, SCHEMAS, rep, "geo")
    assert rep.errors == [] and rep.facts["fields"] == len(feats) and rep.facts["pmtiles"] is True
    first = (run / "fields.geojson").read_bytes()
    first_pm = (run / "fields.pmtiles").read_bytes()
    output.write_run(run, "r99", small_tiles, feats)
    assert (run / "fields.geojson").read_bytes() == first  # T2: byte-identical rerun
    assert (run / "fields.pmtiles").read_bytes() == first_pm
    doc = json.loads(first)
    assert list(doc) == ["v", "run_id", "type", "features"]
    assert list(doc["features"][0]["properties"]) == ["field_id", "tile", "district", "area_ha", "source",
                                                      "rice_mask_frac", "lon", "lat"]


def test_verify_pmtiles_catches_missing_fields(tmp_path, small_tiles, half_rice_raster):
    path, _ = half_rice_raster
    feats, _ = grid.build(small_tiles, path)
    output.write_pmtiles(feats, tmp_path / "f.pmtiles")
    ids = {f["properties"]["field_id"] for f in feats}
    output.verify_pmtiles(tmp_path / "f.pmtiles", ids)
    with pytest.raises(SystemExit):
        output.verify_pmtiles(tmp_path / "f.pmtiles", ids | {"alpha-99999"})
    (tmp_path / "bad.pmtiles").write_bytes(b"not a pmtiles")
    with pytest.raises(SystemExit):
        output.verify_pmtiles(tmp_path / "bad.pmtiles", ids)
