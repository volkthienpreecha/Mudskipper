"""Offline integration checks: real polygon identities, synthetic radar arrays."""
import copy
import json
from pathlib import Path
import sys

import numpy as np
import pytest
from pyproj import Transformer
from shapely import transform
from shapely.geometry import MultiPolygon, Polygon, box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from field_units import FieldUnits, grid_transform, cache_matches
from zonal import db, zonal_records
from freeman_durden import freeman_durden
from export_contract import fid, geo_export_fields, select_fields


X0, Y0 = 500000, 3400000
TO_LL = Transformer.from_crs(32643, 4326, always_xy=True)


def handoff(tmp_path, geometries):
    art = tmp_path / "artifacts"
    art.mkdir(exist_ok=True)
    features = []
    for field_id, geom in geometries:
        g = transform(geom, TO_LL.transform, interleaved=False)
        c = g.representative_point()
        features.append({"type": "Feature", "id": field_id, "geometry": mapping(g), "properties": {
            "field_id": field_id, "tile": "fazilka", "district": "Fazilka", "source": "ftw",
            "area_ha": max(0.5, round(geom.area / 10000, 6)), "rice_mask_frac": 0.731,
            "lon": c.x, "lat": c.y}})
    aoi = {"v": 1, "run_id": "synthetic", "tiles": [{"id": "fazilka", "district": "Fazilka",
            "bbox": [74.9, 30, 75.1, 31]}], "utm_epsg": 32643,
           "season": {"start": "2026-06-17", "end": "2026-10-23"},
           "stages": {"mid_start": "2026-07-15", "late_start": "2026-09-10"}, "gaps": []}
    (art / "fields.geojson").write_text(json.dumps({"v": 1, "run_id": "synthetic",
        "type": "FeatureCollection", "features": features}))
    (art / "aoi.json").write_text(json.dumps(aoi))
    return FieldUnits(art), json.loads(json.dumps(features))


def b(c0, r0, c1, r1):
    # Edges stay away from centres, including after the WGS84 round trip.
    return box(X0 + 10*c0 + .1, Y0 - 10*r1 + .1, X0 + 10*c1 - .1, Y0 - 10*r0 - .1)


def raster(h=4, w=6):
    return {"x": X0 + 5 + 10*np.arange(w), "y": Y0 - 5 - 10*np.arange(h), "epsg": 32643,
            "HHHH": np.ones((h, w)), "HVHV": np.full((h, w), .1), "mask": np.ones((h, w), np.uint8)}


P = {"pass_id": "p20260702", "track": 84, "datetime": "2026-07-02T00:00:00Z", "pol_mode": "DH"}


def test_polygon_ids_holes_multipolygon_and_tile_grid(tmp_path):
    hole = Polygon(b(0, 0, 3, 4).exterior.coords, [b(1, 1, 2, 3).exterior.coords])
    multi = MultiPolygon([b(4, 0, 6, 1), b(4, 3, 6, 4)])
    fields, _ = handoff(tmp_path, [("fazilka-00999", multi), ("fazilka-00007", hole)])
    d = raster()
    lab, crop, total, meta = fields.raster("fazilka", d["x"], d["y"], d["epsg"])
    assert [m["field_id"] for m in meta] == ["fazilka-00007", "fazilka-00999"]
    assert lab[1, 1] == lab[2, 1] == lab[2, 4] == 0  # hole and between multipolygon pieces
    assert lab[0, 4] == lab[3, 5] == 2
    assert total.tolist() == [0, 10, 4]
    assert crop.all()


def test_linear_power_nodata_and_partial_window_coverage(tmp_path):
    fields, features = handoff(tmp_path, [("fazilka-00042", b(0, 0, 4, 2))])
    d = raster(h=2, w=2)  # Only half the complete field is cached.
    d["HHHH"] = np.array([[1., .01], [.1, .4]])
    d["HVHV"] = np.array([[.1, .001], [np.nan, .04]])
    d["mask"][1, 1] = 255
    row, = list(zonal_records(d, P, "fazilka", fields))
    assert row["field_id"] == "fazilka-00042"
    assert row["n_px"] == 2 and row["valid_frac"] == .25
    assert row["observed"] == {"hh_db": db(.505), "hv_db": db(.0505), "hh_hv_db": 10.0}
    assert row["field_source"] == "ftw" and row["rice_mask_frac"] == .731
    assert row["area_ha"] == features[0]["properties"]["area_ha"]
    d["mask"][:] = 0
    empty, = list(zonal_records(d, P, "fazilka", fields))
    assert empty["valid_frac"] == 0 and empty["n_px"] == 0
    assert all(v is None for v in empty["observed"].values())


def test_qp_averages_covariance_before_decomposition_and_masks_all_terms(tmp_path):
    fields, _ = handoff(tmp_path, [("fazilka-00420", b(0, 0, 2, 2))])
    d = raster(h=2, w=2)
    d.update(HHHH=np.array([[.78, 1.3], [.7, .9]]), HVHV=np.full((2, 2), .2),
             VHVH=np.full((2, 2), .4), VVVV=np.array([[2.6, 4.6], [np.nan, 3.]]),
             HHVV=np.array([[.8+.1j, 1.+.2j], [.7, .9]]))
    d["mask"][1, 1] = 0
    row, = list(zonal_records(d, {**P, "pol_mode": "QP"}, "fazilka", fields))
    assert row["n_px"] == 2 and row["valid_frac"] == .5
    ps, pd, pv = freeman_durden(1.04, .3, 3.6, .9+.15j)
    assert row["observed"]["hh_db"] == db(1.04)
    assert row["observed"]["hv_db"] == db(.3)  # HV and VH averaged first
    assert row["observed"]["vv_db"] == db(3.6)
    assert [row["observed"][k] for k in ("ps_db", "pd_db", "pv_db")] == [db(max(float(v), 1e-8)) for v in (ps, pd, pv)]


def test_segment_fallback_retains_ids_crop_and_alignment(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    d = raster(h=4, w=4)
    np.savez(data / "p20260702_fazilka.npz", x=d["x"], y=d["y"], epsg=32643)
    np.savez(data / "segments_fazilka.npz", labels=np.array([[1, 2], [1, 2]]), ml=2,
             area_ha=[.8, 1.2], crop_frac=[.75, 1.])
    crop = np.ones((4, 4), bool)
    crop[0, 0] = False
    np.savez(data / "landcover_fazilka.npz", crop=crop)
    fields = FieldUnits(tmp_path / "no-geo", data)
    records = list(zonal_records(d, P, "fazilka", fields))
    assert [(r["field_id"], r["n_px"], r["valid_frac"]) for r in records] == [
        ("fazilka_s00001", 7, 1.), ("fazilka_s00002", 8, 1.)]
    assert all(r["field_source"] == "segments" for r in records)
    with pytest.raises(ValueError, match="CRS differs"):
        fields.raster("fazilka", d["x"], d["y"], 32644)


def test_geo_export_preserves_geometry_metadata_and_rejects_wrong_measurements(tmp_path):
    fields, features = handoff(tmp_path, [("fazilka-00007", b(0, 0, 2, 2)), ("fazilka-00999", b(3, 0, 5, 2))])
    rows = list(zonal_records(raster(), P, "fazilka", fields))
    for r in rows:
        r["flags"] = ["not_rice_like"]  # keep authoritative rice geometry, carrying uncertainty
    keep, manifest = select_fields(rows, fields)
    collection, aoi = geo_export_fields(fields, keep, {"v": 1, "run_id": "exported"})
    assert collection["features"] == features
    assert manifest["excluded_ids"] == [] and manifest["selected_fields"] == 2
    assert aoi["tiles"] == fields.aoi["tiles"] and aoi["run_id"] == "exported"
    assert fid("fazilka-00999") == "fazilka-00999"
    assert fid("fazilka_s00007") == "fazilka-00007"
    stale = copy.deepcopy(rows)
    stale[0]["field_id"] = "fazilka_s00007"
    with pytest.raises(ValueError, match="no matching field geometry"):
        select_fields(stale, fields)
    stale = copy.deepcopy(rows)
    stale[0]["field_geometry_sha256"] = "old geometry"
    with pytest.raises(ValueError, match="does not match this geo"):
        select_fields(stale, fields)


def test_classifier_preserves_geo_source_and_authoritative_rice(tmp_path, monkeypatch):
    import classify
    fields, _ = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2))])
    rows = list(zonal_records(raster(), P, "fazilka", fields))
    monkeypatch.setattr(classify, "rice_prior", lambda: {"unrelated_segment": 0})
    classify.featurize(rows, {P["pass_id"]: "2026-07-02"})
    assert "provisional_segment_fields" not in rows[0]["flags"]
    assert "not_rice_2024" not in rows[0]["flags"]
    assert rows[0]["field_geometry_sha256"] == fields.fingerprints["fazilka-00042"]


def test_quad_pol_check_rejects_stale_dual_pol_geometry(tmp_path, monkeypatch):
    import qp_check
    fields, _ = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2))])
    row, = list(zonal_records(raster(), P, "fazilka", fields))
    row["field_geometry_sha256"] = "previous geometry with the same ID"
    (fields.art / "passes.json").write_text(json.dumps({"passes": [{**P, "used": True}]}))
    (fields.art / "observations.jsonl").write_text(json.dumps(row) + "\n")
    monkeypatch.setattr(qp_check, "ART", str(fields.art))
    with pytest.raises(ValueError, match="differs from geo handoff"):
        qp_check.main()
    assert not (fields.art / "qp_fields.jsonl").exists()


def test_bad_grids_unmatched_geometry_overlap_and_missing_terms_fail(tmp_path):
    fields, _ = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2))])
    d = raster()
    with pytest.raises(ValueError, match="projected CRS"):
        grid_transform(d["x"], d["y"], 4326)
    with pytest.raises(ValueError, match="regular"):
        grid_transform([0, 1, 3], [10, 9, 8], 32643)
    with pytest.raises(ValueError, match="no geo fields intersect"):
        fields.raster("fazilka", d["x"] + 100000, d["y"], 32643)
    with pytest.raises(ValueError, match="missing physical raster terms"):
        list(zonal_records(d, {**P, "pol_mode": "QP"}, "fazilka", fields))
    fields, _ = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2)), ("fazilka-00043", b(0, 0, 2, 2))])
    with pytest.raises(ValueError, match="overlap"):
        fields.raster("fazilka", d["x"], d["y"], 32643)


def test_synthetic_cli_stages_keep_geo_identity_and_export_metadata(tmp_path, monkeypatch):
    """Exercise the writers, using explicitly constructed synthetic source inputs."""
    import classify
    import export_contract as export
    import overlays
    import zonal
    fields, features = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2))])
    art = fields.art
    data = tmp_path / "data"
    data.mkdir()
    d = raster(2, 2)
    d["granule_id"] = "SAMPLE_SYNTHETIC_TEST_ONLY"
    np.savez(data / "p20260702_fazilka.npz", **d)
    p = {**P, "used": True, "granule_id": "SAMPLE_SYNTHETIC_TEST_ONLY", "direction": "ascending",
         "frame": 17, "crid": "P05023", "maturity": "provisional", "pixel_m": 10,
         "covariance_terms": ["HHHH", "HVHV"], "valid_fraction_by_tile": {"fazilka": 1.}, "excluded_reason": None}
    (art / "passes.json").write_text(json.dumps({"v": 1, "run_id": "synthetic", "passes": [p]}))
    # These are test metadata and digests, not a claim of an acquired granule.
    import hashlib
    digest = hashlib.sha256((data / "p20260702_fazilka.npz").read_bytes()).hexdigest()
    (data / "p20260702_fazilka.npz.json").write_text(json.dumps({"granule_id": p["granule_id"],
        "bbox": fields.aoi["tiles"][0]["bbox"], "subset_sha256": digest}))
    (art / "provenance.json").write_text(json.dumps({"git_sha": "abcdef0", "created_at": "2026-11-14T01:02:03+00:00",
        "granules": [{"granule_id": p["granule_id"], "subset_sha256": {"fazilka": digest}}]}))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TILES", raising=False)
    monkeypatch.delenv("ONLY_TILE", raising=False)
    monkeypatch.delenv("RUN_CREATED_AT", raising=False)
    monkeypatch.delenv("RUN_GIT_SHA", raising=False)
    for module in (zonal, classify, overlays):
        monkeypatch.setattr(module, "ART", str(art))
        monkeypatch.setattr(module, "RUN", "synthetic")
    zonal.main()
    classify.main()  # <20 pixels correctly stay uncertain; no scientific model is fitted.
    overlays.main()
    observed = [json.loads(l) for l in (art / "observations.jsonl").read_text().splitlines()]
    assert observed[0]["field_id"] == "fazilka-00042"
    assert observed[0]["inferred"]["state"] == "uncertain"
    assert observed[0]["field_geometry_sha256"] == fields.fingerprints["fazilka-00042"]
    index = json.loads((art / "overlays/index.json").read_text())
    assert index[0]["field_ids"] == ["fazilka-00042"]
    dest = tmp_path / "exported"
    monkeypatch.setattr(export, "SRC", str(art))
    monkeypatch.setattr(export, "DST", str(dest))
    monkeypatch.setattr(export, "IN", "synthetic")
    monkeypatch.setattr(export, "OUT", "synthetic_export")
    export.main()
    exported_fields = json.loads((dest / "fields.geojson").read_text())
    assert exported_fields["features"] == features
    exported_obs = [json.loads(l) for l in (dest / "observations.jsonl").read_text().splitlines()]
    assert exported_obs[0]["field_id"] == "fazilka-00042"
    assert exported_obs[0]["pass_id"] == "20260702-T084A"
    prov = json.loads((dest / "provenance.json").read_text())
    assert prov["created_at"] == "2026-11-14T01:02:03Z"
    assert all((dest / a["path"]).is_file() for a in prov["artifacts"])
    assert json.loads((dest / "field_selection.json").read_text())["excluded_ids"] == []


@pytest.mark.parametrize("is_geo,n_tiles,n_fields", [(True, 1, 3503), (False, 3, 2200)])
def test_field_limit_sampling_is_deterministic_and_lists_every_excluded_id(is_geo, n_tiles, n_fields):
    from types import SimpleNamespace
    by_tile, rows, fingerprints = {}, [], {}
    for ti in range(n_tiles):
        tile = f"tile{ti}"
        meta = [{"field_id": f"{tile}-{i:05d}" if is_geo else f"{tile}_s{i:05d}", "tile": tile,
                 "source": "ftw" if is_geo else "segments"} for i in range(n_fields)]
        by_tile[tile] = meta
        for props in meta:
            fingerprints[props["field_id"]] = "synthetic hash for sampling test"
            rows.append({**props, "field_source": props["source"], "flags": [],
                         "field_geometry_sha256": fingerprints[props["field_id"]]})
    fields = SimpleNamespace(geo=is_geo, tiles=lambda: sorted(by_tile), metadata=lambda t: by_tile[t], fingerprints=fingerprints)
    keep, manifest = select_fields(rows, fields)
    again, same_manifest = select_fields(list(reversed(rows)), fields)
    assert keep == again and manifest == same_manifest
    assert len(keep) <= 5000
    all_ids = {r["field_id"] for r in rows}
    assert set(manifest["excluded_ids"]) == all_ids - keep
    assert set(manifest["selected_ids"]) == keep
    if is_geo:
        assert keep == all_ids  # Keep an imbalanced geo tile intact when the total fits.
    else:
        assert len(keep) == 4998 and len(manifest["excluded_ids"]) == 1602


def test_missing_radar_handoff_fails_without_writing_observations(tmp_path, monkeypatch):
    import zonal
    fields, _ = handoff(tmp_path, [("fazilka-00042", b(0, 0, 2, 2))])
    monkeypatch.setattr(zonal, "ART", str(fields.art))
    with pytest.raises(SystemExit, match="no radar passes or measurements"):
        zonal.main()
    assert not (fields.art / "zonal.jsonl").exists()


def test_provenance_rejects_missing_or_invalid_physical_subset_hashes():
    from export_contract import granule_list, gsha
    with pytest.raises(ValueError, match="missing physical subset checksums"):
        gsha({}, ["fazilka"])
    with pytest.raises(ValueError, match="invalid subset checksum"):
        gsha("not-a-checksum", ["fazilka"])
    with pytest.raises(ValueError, match="no source provenance"):
        granule_list([{"used": True, "granule_id": "SAMPLE_TEST", "crid": "P05023"}], {"granules": []}, ["fazilka"])


def test_cache_reuse_requires_matching_aoi_granule_and_bytes(tmp_path):
    import hashlib
    path = tmp_path / "tile.npz"
    np.savez(path, **raster(2, 2))
    bbox = [74.9, 30., 75.1, 31.]
    side = {"granule_id": "SAMPLE_TEST", "bbox": bbox, "subset_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    Path(str(path) + ".json").write_text(json.dumps(side))
    assert cache_matches(path, bbox, "SAMPLE_TEST")
    assert not cache_matches(path, [74., 30., 75., 31.], "SAMPLE_TEST")
    assert not cache_matches(path, bbox, "SAMPLE_DIFFERENT")
    path.write_bytes(b"changed cache")
    assert not cache_matches(path, bbox, "SAMPLE_TEST")
