"""validate.py accepts the fixtures and rejects each kind of broken run (negative tests for T1, T3-T6, T8)."""
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import validate  # noqa: E402

FIXTURES = HERE / "fixtures"
SCHEMAS = validate.Schemas()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="mudskipper-validate-"))
        self.root = self.tmp / "fixtures"
        shutil.copytree(FIXTURES, self.root)
        self.run_dir = self.root / "run"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    # helpers
    def edit_json(self, rel, fn, root=None):
        path = (root or self.run_dir) / rel
        doc = json.loads(path.read_text(encoding="utf-8"))
        fn(doc)  # mutates in place
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def edit_jsonl(self, rel, fn):
        path = self.run_dir / rel
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        result = fn(rows)
        rows = result if isinstance(result, list) else rows
        path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows),
                        encoding="utf-8")

    def validate_root(self, recompute=False):
        rep = validate.Report("test")
        validate.validate_fixture_root(self.root, SCHEMAS, rep, recompute)
        return rep

    def assertFails(self, rep, *needles):
        joined = "\n".join(rep.errors)
        for needle in needles:
            self.assertIn(needle, joined, f"expected an error containing {needle!r}; got:\n{joined[:3000]}")


class AcceptsFixtures(Base):
    def test_clean_fixtures_pass(self):
        rep = self.validate_root()
        self.assertEqual(rep.errors, [])
        self.assertEqual(rep.facts["fields"], 300)
        self.assertTrue(rep.facts["fixture"])


class RejectsBrokenRuns(Base):
    def test_t5_used_pass_inside_gap(self):
        def move(doc):
            for p in doc["passes"]:
                if p["pass_id"] == "20260810-T135D":
                    p["datetime"] = "2026-08-10T00:30:00Z"
        self.edit_json("passes.json", move)
        self.assertFails(self.validate_root(), "T5: used pass 2026-08-10T00:30:00Z is inside a data gap",
                         "T5: observation dated 2026-08-10T00:30:00Z inside a data gap")

    def test_t4_two_crids_in_one_series(self):
        def recrid(doc):
            p = next(p for p in doc["passes"] if p["pass_id"] == "20260922-T135D" or p["pass_id"] == "20260927-T135D")
            p["crid"] = "P05036"
            p["granule_id"] = p["granule_id"].replace("_P05023_", "_P05036_")
        self.edit_json("passes.json", recrid)
        self.assertFails(self.validate_root(), "T4: series ('descending', 135, 73) mixes CRIDs ['P05023', 'P05036']")

    def test_t3_missing_granule_in_provenance(self):
        self.edit_json("provenance.json", lambda d: d["granules"].pop(0))
        self.assertFails(self.validate_root(), "T3: pass 20260623-T135D has no granule entry")

    def test_t3_excluded_passes_also_need_granules(self):
        self.edit_json("provenance.json", lambda d: d.__setitem__("granules", [g for g in d["granules"] if g["subset_sha256"]]))
        self.assertFails(self.validate_root(), "T3: pass 20260714-T084A has no granule entry")

    def test_nan_is_rejected(self):
        path = self.run_dir / "observations.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        lines[0] = lines[0].replace('"p_flooded":', '"p_flooded":NaN,"x":', 1)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertFails(self.validate_root(), "non-finite number NaN")

    def test_t3_real_run_cannot_use_sample_granules(self):
        for path in self.run_dir.rglob("*"):
            if path.suffix in (".json", ".geojson") and path.is_file():
                self.edit_json(path.relative_to(self.run_dir).as_posix(), lambda d: d.pop("fixture", None))
            elif path.suffix == ".jsonl":
                self.edit_jsonl(path.relative_to(self.run_dir).as_posix(), lambda rows: [
                    {k: v for k, v in r.items() if k != "fixture"} for r in rows])
        rep = validate.Report("test")
        validate.validate_run(self.run_dir, SCHEMAS, rep)
        self.assertFalse(rep.facts["fixture"])
        self.assertFails(rep, "T3: a real run cannot use SAMPLE_ granule ids",
                         "param drained_fraction_of_cycle still needs a citation (real run)",
                         "git_sha 'fixture' in a real run")

    def test_uncertain_rule(self):
        def flip(rows):
            r = next(r for r in rows if r["inferred"]["state"] == "flooded")
            r["inferred"]["state"] = "uncertain"
        self.edit_jsonl("observations.jsonl", flip)
        self.assertFails(self.validate_root(), "uncertain rule: state uncertain")

    def test_t6_verdict_must_follow_the_rule(self):
        def flip(rows):
            r = next(r for r in rows if r["awd"]["verdict"] == "consistent")
            r["awd"]["verdict"] = "inconsistent"
        self.edit_jsonl("field_summary.jsonl", flip)
        self.assertFails(self.validate_root(), "T6: verdict inconsistent but the rule gives consistent")

    def test_drained_hits_recomputed_from_observations(self):
        def bump(rows):
            rows[0]["awd"]["drained_hits"] += 1
        self.edit_jsonl("field_summary.jsonl", bump)
        self.assertFails(self.validate_root(), "but observations give")

    def test_recompute_catches_a_changed_probability(self):
        def nudge(rows):
            r = next(r for r in rows if r["awd"]["clear_looks"] > 0)
            r["awd"]["p_catch_ge1_if_awd"] = r["awd"]["p_catch_ge1_if_awd"] / 2
        self.edit_jsonl("field_summary.jsonl", nudge)
        self.assertFails(self.validate_root(recompute=True), "--recompute: summary differs")

    def test_detectability_internal_consistency(self):
        def bad(doc):
            doc["results"]["k_star"] = 1
        self.edit_json("detectability.json", bad)
        self.assertFails(self.validate_root(), "k_star 1 but the CF distribution gives")

    def test_missing_observation_line(self):
        self.edit_jsonl("observations.jsonl", lambda rows: rows[1:])
        self.assertFails(self.validate_root(), "field x used-pass pairs have no line")

    def test_provenance_hash_and_unlisted_file(self):
        story = self.run_dir / "story.json"
        story.write_text(story.read_text(encoding="utf-8") + " ", encoding="utf-8")
        (self.run_dir / "notes.txt").write_text("hi", encoding="utf-8")
        self.assertFails(self.validate_root(), "sha256 mismatch for story.json", "notes.txt is not listed in artifacts",
                         "unexpected file in run directory")

    def test_states_recomputed(self):
        self.edit_json("states.json", lambda d: d["states"].__setitem__(0, "-" * len(d["states"][0])))
        self.assertFails(self.validate_root(), "states disagrees with passes/observations")

    def test_story_rule(self):
        self.edit_json("story.json", lambda d: d.update(hero_field_id="muktsar-00001"))
        self.assertFails(self.validate_root(), "hero_field_id = 'muktsar-00001', rule gives")

    def test_schema_errors_are_reported(self):
        self.edit_json("aoi.json", lambda d: d["gaps"].clear())
        self.assertFails(self.validate_root(), "aoi.json: gaps")

    def test_nisar_gap_must_be_listed(self):
        self.edit_json("aoi.json", lambda d: d["gaps"][0].update(end="2026-08-09T00:00:00Z"))
        self.assertFails(self.validate_root(), "gaps must include the permanent NISAR gap")

    def test_overlay_must_cover_tile(self):
        self.edit_json("overlays/index.json", lambda d: d["overlays"][0]["coordinates"][0].__setitem__(0, 74.0))
        self.assertFails(self.validate_root(), "coordinates must be the tile bbox corners")

    def test_granule_name_must_match_pass(self):
        def bad(doc):
            doc["passes"][0]["track"] = 136
        self.edit_json("passes.json", bad)
        self.assertFails(self.validate_root(), "track 136 != granule 135")

    def test_t8_api_response_without_fixture_flag(self):
        self.edit_json("story.json", lambda d: d.pop("fixture"), root=self.root / "api")
        self.assertFails(self.validate_root(), "T8: fixture responses must carry fixture: true")

    def test_golden_audit_response(self):
        def swap(doc):
            doc["ranked"][0], doc["ranked"][1] = doc["ranked"][1], doc["ranked"][0]
        self.edit_json("audit.response.json", swap, root=self.root / "api")
        self.assertFails(self.validate_root(), "golden ranking differs from rules.rank")

    def test_district_sums(self):
        self.edit_json("district_check.json", lambda d: d["rows"][0].update(tile_rice_ha=1.0))
        self.assertFails(self.validate_root(), "Fazilka: tile_rice_ha 1.0 but fields sum to")

    def test_opera_caveat_required(self):
        self.edit_json("checks.json", lambda d: d["opera"].update(note="fine"))
        self.assertFails(self.validate_root(), "opera.note must carry the 30 m / 3 ha caveat")


class NeverCrashes(Base):
    def test_malformed_files_are_reported_not_raised(self):
        self.edit_json("provenance.json", lambda d: d.pop("granules"))
        self.edit_json("story.json", lambda d: d.clear(), root=self.root / "api")
        (self.run_dir / "passes.json").write_text("{not json", encoding="utf-8")
        rep = self.validate_root()
        self.assertFails(rep, "passes.json: cannot parse")
        (self.run_dir / "passes.json").unlink()
        rep = self.validate_root()
        self.assertFails(rep, "passes.json: required at stage 'published' but missing")


class CommandLine(unittest.TestCase):
    def test_exit_codes(self):
        self.assertEqual(validate.main([str(FIXTURES), "--quiet"]), 0)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(validate.main([tmp]), 2)


if __name__ == "__main__":
    unittest.main()
