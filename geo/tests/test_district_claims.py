"""district_check.py reproduces the fixture table; claims_sample.py makes 60 synthetic claims that rank."""
import copy
import json
import sys

import pytest

import claims_sample
import common as c
import district_check
from common import REPO, rules

sys.path.insert(0, str(REPO / "contracts"))
import validate  # noqa: E402

FIXTURE_RUN = REPO / "contracts" / "fixtures" / "run"
SCHEMAS = validate.Schemas()


def fixture_inputs():
    return district_check.load(FIXTURE_RUN)


def test_reproduces_the_committed_fixture_byte_for_byte(tmp_path):
    out = tmp_path / "district_check.json"
    assert district_check.main(["--run-dir", str(FIXTURE_RUN), "--out", str(out)]) == 0
    assert out.read_bytes() == (FIXTURE_RUN / "district_check.json").read_bytes()


def test_tile_sums_and_null_district():
    fields_doc, summaries = fixture_inputs()
    doc = district_check.build(fields_doc, summaries)
    assert SCHEMAS.errors("district_check", doc) == []
    rows = {r["district"]: r for r in doc["rows"]}
    props = [f["properties"] for f in fields_doc["features"]]
    for d in ("Fazilka", "Sri Muktsar Sahib"):
        mine = [p for p in props if p["district"] == d]
        dsr = [p for p in mine if summaries[p["field_id"]]["dsr"]["signal"] == "dsr_signal"]
        assert rows[d]["tile_rice_ha"] == pytest.approx(sum(p["area_ha"] for p in mine), abs=0.005)
        assert rows[d]["tile_dsr_signal_ha"] == pytest.approx(sum(p["area_ha"] for p in dsr), abs=0.005)
        assert rows[d]["tile_dsr_signal_frac"] == pytest.approx(rows[d]["tile_dsr_signal_ha"] / rows[d]["tile_rice_ha"], abs=1e-3)
    assert rows["Ferozepur"]["tile_rice_ha"] is None and rows["Ferozepur"]["gov_dsr_acres"] == 38088.59
    assert [r["gov_farmers"] for r in doc["rows"]] == [12063, 7345, 1929]


def test_real_run_note_satisfies_the_validator():
    fields_doc, summaries = fixture_inputs()
    real = copy.deepcopy(fields_doc)
    real.pop("fixture")
    doc = district_check.build(real, summaries)
    assert "fixture" not in doc
    note = doc["note"].lower()
    assert "not a district" in note and "signal, not proof" in note and "sample" not in note
    rep = validate.Report("x")
    validate.check_district(doc, [f["properties"] for f in real["features"]], summaries, rep)
    assert rep.errors == []


def test_missing_summary_is_an_error():
    fields_doc, summaries = fixture_inputs()
    summaries.pop(next(iter(summaries)))
    with pytest.raises(SystemExit):
        district_check.build(fields_doc, summaries)


# ------------------------------------------------------------------------------------------------ claims
@pytest.fixture(scope="module")
def sample():
    fields_doc = json.loads((FIXTURE_RUN / "fields.geojson").read_text(encoding="utf-8"))
    aoi = json.loads((FIXTURE_RUN / "aoi.json").read_text(encoding="utf-8"))
    return fields_doc, aoi, claims_sample.build(fields_doc, aoi)


def test_sixty_unique_synthetic_claims(sample):
    fields_doc, _, doc = sample
    assert SCHEMAS.errors("claims", doc) == []
    feats = doc["features"]
    assert len(feats) == 60
    ids = [f["properties"]["claim_id"] for f in feats]
    assert ids == [f"SYN-{i:04d}" for i in range(1, 61)]
    assert all(f["properties"]["synthetic"] is True for f in feats)
    allowed = {"claim_id", "claimed", "synthetic", "field_id", "area_ha"}
    assert all(set(f["properties"]) <= allowed for f in feats)  # nothing about a person
    known = {f["properties"]["field_id"] for f in fields_doc["features"]}
    assert all(f["properties"].get("field_id", next(iter(known))) in known for f in feats)
    kinds = {f["geometry"]["type"] for f in feats}
    assert {"Point", "Polygon"} <= kinds
    assert sum("field_id" in f["properties"] for f in feats) >= 10
    unmatched_with_area = [f for f in feats if "area_ha" in f["properties"]]
    assert len(unmatched_with_area) == 3


def test_ranking_sees_54_matched_and_6_unmatched(sample):
    fields_doc, _, doc = sample
    body = json.dumps({"claims": doc, "budget": 20, "seed": 7}).encode()
    resp = rules.rank(body, fields_doc["features"], {}, "fixture", "2026-11-14T00:00:00Z", True)
    assert (resp["matched"], resp["unmatched"]) == (54, 6)
    # one field carries two claims (candidate merging): 53 matched candidates + 6 unmatched
    matched_fields = []
    for f in doc["features"]:
        fid = f["properties"].get("field_id")
        if fid is None and f["geometry"]["type"] == "Point":
            x, y = f["geometry"]["coordinates"]
            hits = sorted(g["properties"]["field_id"] for g in fields_doc["features"] if rules.contains(g["geometry"], x, y))
            fid = hits[0] if hits else None
        elif fid is None:
            x, y = rules.representative_point(f["geometry"])
            hits = sorted(g["properties"]["field_id"] for g in fields_doc["features"] if rules.contains(g["geometry"], x, y))
            fid = hits[0] if hits else None
        if fid:
            matched_fields.append(fid)
    assert len(matched_fields) == 54 and len(set(matched_fields)) == 53


def test_claims_are_deterministic_and_seeded(sample):
    fields_doc, aoi, doc = sample
    assert claims_sample.build(fields_doc, aoi) == doc
    assert claims_sample.build(fields_doc, aoi, seed=1) != doc


def test_validator_accepts_the_sample_in_a_published_run(tmp_path, sample):
    import shutil
    run = tmp_path / "run"
    shutil.copytree(FIXTURE_RUN, run)
    _, _, doc = sample
    text = c.dump_collection({k: v for k, v in doc.items() if k != "features"}, doc["features"])
    (run / "claims.sample.geojson").write_text(text, encoding="utf-8")
    rep = validate.Report("x")
    validate.check_claims(json.loads(text), {f["properties"]["field_id"]: f for f in
                                             json.loads((run / "fields.geojson").read_text())["features"]}, True, rep)
    assert rep.errors == []
