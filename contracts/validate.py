#!/usr/bin/env python3
"""Validate fixtures and run artifacts against contracts/CONTRACTS.md (acceptance test T1).

    python3 contracts/validate.py                    # contracts/fixtures + every artifacts/<run_id>/
    python3 contracts/validate.py artifacts/r01      # one run directory
    python3 contracts/validate.py --recompute ...    # also rerun the simulation and compare core's numbers exactly
    python3 contracts/validate.py artifacts/r01 --stage geo   # geo's hand-off only: aoi.json + fields (+ pmtiles)

A target is either a run directory (it has aoi.json) or a fixtures root (it has run/ and api/). Checks:
JSON Schema for every file and every JSONL line, then the cross-file rules: ids and run_id agree, one CRID per
series (T4), nothing used inside the data gap (T5), every used pass has its granule in provenance (T3), the
uncertain rule, verdicts and DSR signals recomputed from the observations (T6), story and district numbers
recomputed, hashes in provenance, overlays on disk, and the fixture flag on every API response (T8).

Exit status: 0 when there are no errors (warnings allowed), 1 on errors, 2 on usage or setup problems.
Needs `jsonschema` (contracts/requirements.txt); everything else is the standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from dataclasses import dataclass, field

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rules  # noqa: E402

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
except ImportError:  # pragma: no cover - exercised by people without the venv
    sys.stderr.write("validate.py needs jsonschema: run `make setup` (or pip install -r contracts/requirements.txt)\n")
    sys.exit(2)

SCHEMA_DIR = HERE / "schemas"
SCHEMA_BASE = "https://mudskipper.invalid/schemas/v1/"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PMTILES_MAGIC = b"PMTiles\x03"
NISAR_GAP = ("2026-07-27T22:03:25Z", "2026-08-10T00:55:27Z")
MAX_ERRORS_PER_FILE = 25

RUN_FILES = {  # name -> (schema, kind)
    "aoi.json": ("aoi", "json"),
    "fields.geojson": ("fields", "json"),
    "passes.json": ("passes", "json"),
    "observations.jsonl": ("observation", "jsonl"),
    "field_summary.jsonl": ("field_summary", "jsonl"),
    "detectability.json": ("detectability", "json"),
    "district_check.json": ("district_check", "json"),
    "checks.json": ("checks", "json"),
    "provenance.json": ("provenance", "json"),
    "story.json": ("story", "json"),
    "states.json": ("states", "json"),
    "claims.sample.geojson": ("claims", "json"),
    "overlays/index.json": ("overlays_index", "json"),
}
REQUIRED = {
    "geo": ["aoi.json", "fields.geojson"],  # geo's hand-off before the pipeline runs (CONTRACTS.md B3, "geo" stage)
    "pipeline": ["aoi.json", "fields.geojson", "passes.json", "observations.jsonl", "provenance.json",
                 "overlays/index.json"],
    "published": ["aoi.json", "fields.geojson", "passes.json", "observations.jsonl", "provenance.json",
                  "overlays/index.json", "detectability.json", "field_summary.jsonl", "story.json", "states.json"],
}
DAY2 = ["checks.json", "district_check.json"]
API_FILES = {
    "health.json": "api/health", "meta.json": "api/meta", "story.json": "api/story", "passes.json": "api/passes",
    "fields.json": "api/fields_page", "detectability.json": "api/detectability", "checks.json": "api/checks",
    "provenance.json": "api/provenance", "states.json": "api/states", "audit.request.json": "api/audit_request",
    "audit.response.json": "api/audit_response",
}


# ------------------------------------------------------------------------------------------------ reporting
@dataclass
class Report:
    target: str
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    _per_file: dict = field(default_factory=dict)

    def error(self, where: str, msg: str):
        n = self._per_file.get(where, 0) + 1
        self._per_file[where] = n
        if n <= MAX_ERRORS_PER_FILE:
            self.errors.append(f"{where}: {msg}")
        elif n == MAX_ERRORS_PER_FILE + 1:
            self.errors.append(f"{where}: … more errors suppressed")

    def warn(self, where: str, msg: str):
        self.warnings.append(f"{where}: {msg}")

    def check(self, ok: bool, where: str, msg: str) -> bool:
        if not ok:
            self.error(where, msg)
        return ok


# ------------------------------------------------------------------------------------------------ schemas
def _ecma_anchors(node):
    r"""JSON Schema patterns are ECMA-262, where `$` matches only at the end of input. Python's `$` also matches
    before a trailing newline, so `"abc\n"` would pass `^[a-z]+$`. Rewrite a final unescaped `$` to `\Z`."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "pattern" and isinstance(v, str) and v.endswith("$") and not v.endswith("\\$"):
                v = v[:-1] + "\\Z"
            out[k] = _ecma_anchors(v)
        return out
    if isinstance(node, list):
        return [_ecma_anchors(v) for v in node]
    return node


class Schemas:
    def __init__(self):
        docs = [_ecma_anchors(json.loads(p.read_text(encoding="utf-8")))
                for p in sorted(SCHEMA_DIR.rglob("*.schema.json"))]
        registry = Registry().with_resources([(d["$id"], Resource.from_contents(d)) for d in docs])
        self._validators = {}
        for d in docs:
            name = d["$id"][len(SCHEMA_BASE):-len(".schema.json")]
            Draft202012Validator.check_schema(d)
            self._validators[name] = Draft202012Validator(d, registry=registry)

    def errors(self, name: str, instance) -> list[str]:
        out = []
        for e in sorted(self._validators[name].iter_errors(instance), key=lambda e: list(e.absolute_path)):
            path = "/".join(str(p) for p in e.absolute_path) or "(root)"
            msg = e.message if len(e.message) < 200 else e.message[:197] + "..."
            out.append(f"{path}: {msg}")
        return out


# ------------------------------------------------------------------------------------------------ loading
def _no_nonfinite(token: str):
    raise ValueError(f"non-finite number {token} (CONTRACTS.md C0: finite numbers only)")


def parse(text: str):
    return json.loads(text, parse_constant=_no_nonfinite)


def load_json(path: pathlib.Path, rep: Report, where: str):
    try:
        return parse(path.read_text(encoding="utf-8"))
    except RecursionError:
        rep.error(where, "cannot parse: RecursionError (JSON nested too deeply)")
        return None
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        rep.error(where, f"cannot parse: {exc}")
        return None


def load_jsonl(path: pathlib.Path, rep: Report, where: str):
    rows = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        rep.error(where, f"cannot read: {exc}")
        return None
    for i, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            rep.error(f"{where}:{i}", "blank line")
            continue
        try:
            rows.append((i, parse(line)))
        except RecursionError:
            rep.error(f"{where}:{i}", "cannot parse: RecursionError (JSON nested too deeply)")
        except ValueError as exc:
            rep.error(f"{where}:{i}", f"cannot parse: {exc}")
    return rows


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------------------------------ run checks
def guarded(section: str, rep: Report, fn, *args):
    """Run a group of cross-file checks; malformed input becomes an error, never a crash."""
    try:
        fn(*args)
    except (KeyError, TypeError, ValueError, AttributeError, IndexError, ZeroDivisionError) as exc:
        hint = "after schema errors above" if rep.errors else "validator bug? please report"
        rep.error(section, f"checks stopped early ({hint}): {type(exc).__name__}: {exc}")


def validate_run(run: pathlib.Path, schemas: Schemas, rep: Report, stage: str = "auto", recompute: bool = False):
    guarded("run", rep, _validate_run, run, schemas, rep, stage, recompute)


def _validate_run(run: pathlib.Path, schemas: Schemas, rep: Report, stage: str, recompute: bool):
    if stage == "auto":
        if (run / "field_summary.jsonl").exists():
            stage = "published"
        elif (run / "passes.json").exists() or (run / "observations.jsonl").exists():
            stage = "pipeline"
        else:
            stage = "geo"  # only geo's hand-off so far (aoi.json + fields.geojson)
    rep.facts["stage"] = stage
    for name in REQUIRED[stage]:
        rep.check((run / name).exists(), name, f"required at stage '{stage}' but missing")
    if stage == "published":
        for name in DAY2:
            if not (run / name).exists():
                rep.warn(name, "Day 2 file not built yet")

    # 1. schema, per file / per line
    data: dict = {}
    for name, (schema, kind) in RUN_FILES.items():
        path = run / name
        if not path.exists():
            continue
        if stage == "geo" and name not in REQUIRED["geo"]:
            continue
        if kind == "json":
            doc = load_json(path, rep, name)
            if doc is not None:
                for err in schemas.errors(schema, doc):
                    rep.error(name, err)
            data[name] = doc
        else:
            rows = load_jsonl(path, rep, name)
            if rows is not None:
                for i, row in rows:
                    for err in schemas.errors(schema, row):
                        rep.error(f"{name}:{i}", err)
            data[name] = rows
    expected_files = set(RUN_FILES) | {"fields.pmtiles"}
    for path in sorted(p for p in run.rglob("*") if p.is_file()):
        rel = path.relative_to(run).as_posix()
        if rel in expected_files:
            continue
        if rel.startswith("overlays/") and rel.endswith(".png"):
            continue
        if rel in ("hist/early.png", "hist/mid.png", "hist/late.png"):
            continue
        rep.error(rel, "unexpected file in run directory (not in CONTRACTS.md B3)")
    if rep.errors:
        rep.facts["note"] = "schema errors found; cross-file checks may be incomplete"

    aoi = data.get("aoi.json")
    fields_doc = data.get("fields.geojson")
    passes_doc = data.get("passes.json")
    obs_rows = data.get("observations.jsonl") or []
    if stage == "geo":
        _validate_geo(run, aoi, fields_doc, data, rep)
        return
    if not (aoi and fields_doc and passes_doc):
        return

    is_fixture = check_headers(data, rep)
    tiles, gaps = check_aoi(aoi, rep)
    season, st = aoi["season"], aoi["stages"]

    # 4. passes
    passes = passes_doc["passes"]
    pass_by_id = {p["pass_id"]: p for p in passes}
    rep.check(len(pass_by_id) == len(passes), "passes.json", "duplicate pass_id")
    rep.check(len({p["granule_id"] for p in passes}) == len(passes), "passes.json", "duplicate granule_id")
    used = [p for p in passes if p["used"]]
    rep.check(bool(used), "passes.json", "no used passes")
    season_lo = rules.parse_ms(season["start"])
    season_hi = rules.parse_ms(season["end"]) + rules.DAY_MS
    series: dict = {}
    for p in passes:
        where = f"passes.json:{p['pass_id']}"
        check_granule(p, is_fixture, rep, where)
        if p["used"]:
            rep.check(not rules.in_gap(p["datetime"], gaps), where, f"T5: used pass {p['datetime']} is inside a data gap")
            rep.check(season_lo <= rules.parse_ms(p["datetime"]) < season_hi, where, "used pass outside the season")
            series.setdefault((p["direction"], p["track"], p["frame"]), set()).add(p["crid"])
        off_diag = [c for c in p["covariance_terms"] if c[:2] != c[2:]]
        if p["pol_mode"] == "DH":
            rep.check(not off_diag, where, "DH pass lists off-diagonal covariance terms (only quad-pol has them)")
        for tile_id in p["valid_fraction_by_tile"]:
            rep.check(tile_id in tiles, where, f"valid_fraction_by_tile names unknown tile {tile_id}")
    for key, crids in series.items():
        rep.check(len(crids) == 1, "passes.json", f"T4: series {key} mixes CRIDs {sorted(crids)}")
    directions = {k[0] for k in series}
    rep.check(len(directions) <= 2, "passes.json", "more than two directions used")
    if len(directions) == 2:
        rep.warn("passes.json", "two directions used: classification thresholds must be per direction (SPEC A6)")
    rep.facts["passes"] = f"{len(used)} used / {len(passes)}"

    # 5. fields
    features = fields_doc["features"]
    props = [f["properties"] for f in features]
    field_by_id = check_fields(features, tiles, rep)

    # 6. observations
    seen, obs_by_field = set(), {}
    for i, o in obs_rows:
        where = f"observations.jsonl:{i}"
        key = (o["field_id"], o["pass_id"])
        rep.check(key not in seen, where, f"duplicate observation {key}")
        seen.add(key)
        p = pass_by_id.get(o["pass_id"])
        if not rep.check(p is not None, where, f"unknown pass_id {o['pass_id']}"):
            continue
        rep.check(o["field_id"] in field_by_id, where, f"unknown field_id {o['field_id']}")
        rep.check(p["used"], where, f"observation on excluded pass {o['pass_id']}")
        rep.check(not rules.in_gap(p["datetime"], gaps), where, f"T5: observation dated {p['datetime']} inside a data gap")
        rep.check(o["stage"] == rules.stage_of(p["datetime"], st), where,
                  f"stage {o['stage']} != {rules.stage_of(p['datetime'], st)} for {p['datetime']}")
        inf, obs = o["inferred"], o["observed"]
        rep.check(inf["state"] == rules.state_from(inf["p_flooded"], o["valid_frac"]), where,
                  f"uncertain rule: state {inf['state']} with p_flooded={inf['p_flooded']} valid_frac={o['valid_frac']}")
        expected_conf = rules.confidence_from(inf["p_flooded"])
        rep.check((expected_conf is None and inf["confidence"] is None)
                  or (expected_conf is not None and inf["confidence"] is not None
                      and abs(inf["confidence"] - expected_conf) <= 1e-3),
                  where, "confidence must be |2*p_flooded - 1|")
        if p["pol_mode"] == "DH":
            rep.check(inf["method"] == "hhhv_v1", where, "a DH pass must use method hhhv_v1")
        if inf["method"] == "fd_gmm_v1":
            rep.check(all(obs.get(k) is not None for k in ("ps_db", "pd_db", "pv_db")), where,
                      "fd_gmm_v1 needs ps_db, pd_db and pv_db")
        if None in (obs.get("hh_db"), obs.get("hv_db"), obs.get("hh_hv_db")):
            rep.check(o["valid_frac"] == 0, where, "observed values may be null only when valid_frac is 0")
        else:
            rep.check(abs(obs["hh_hv_db"] - (obs["hh_db"] - obs["hv_db"])) <= 0.011, where, "hh_hv_db != hh_db - hv_db")
        obs_by_field.setdefault(o["field_id"], []).append(o)
    missing = [(fid, p["pass_id"]) for fid in field_by_id for p in used if (fid, p["pass_id"]) not in seen]
    rep.check(not missing, "observations.jsonl",
              f"{len(missing)} field x used-pass pairs have no line, e.g. {missing[:3]}")
    rep.facts["observations"] = len(obs_rows)

    # 7. provenance
    prov = data.get("provenance.json")
    if prov:
        granules = {g["granule_id"]: g for g in prov["granules"]}
        for p in passes:
            g = granules.get(p["granule_id"])
            if rep.check(g is not None, "provenance.json", f"T3: pass {p['pass_id']} has no granule entry"):
                rep.check(g["crid"] == p["crid"], "provenance.json", f"CRID differs for {p['granule_id']}")
                if p["used"]:
                    rep.check(g["subset_sha256"] is not None, "provenance.json",
                              f"used pass {p['pass_id']} needs the subset_sha256 of its cached subset")
        known = {p["granule_id"] for p in passes}
        for gid in granules:
            rep.check(gid in known, "provenance.json", f"granule {gid} is not in passes.json")
        rep.check(prov["git_sha"] != "fixture" or is_fixture, "provenance.json", "git_sha 'fixture' in a real run")
        listed = {}
        for a in prov["artifacts"]:
            rep.check(a["path"] not in listed, "provenance.json", f"{a['path']} listed twice")
            listed[a["path"]] = a["sha256"]
            # The schema's path pattern admits "." and ".." segments; never read outside the run (K-345).
            parts = pathlib.PurePosixPath(a["path"]).parts
            if not rep.check(bool(parts) and not a["path"].startswith("/") and all(seg not in (".", "..") for seg in parts),
                             "provenance.json", f"artifact path {a['path']!r} leaves the run directory"):
                continue
            path = run / a["path"]
            if rep.check(path.is_file(), "provenance.json", f"lists {a['path']}, which does not exist"):
                rep.check(sha256(path) == a["sha256"], "provenance.json", f"sha256 mismatch for {a['path']}")
        rep.check([a["path"] for a in prov["artifacts"]] == sorted(listed), "provenance.json", "artifacts must be sorted by path")
        for path in sorted(p for p in run.rglob("*") if p.is_file()):
            rel = path.relative_to(run).as_posix()
            if rel != "provenance.json":
                rep.check(rel in listed, "provenance.json", f"{rel} is not listed in artifacts")

    # 8. overlays and histograms
    ov = data.get("overlays/index.json")
    if ov:
        referenced = set()
        for e in ov["overlays"]:
            where = f"overlays/index.json:{e['url']}"
            referenced.add(e["url"])
            rep.check(e["url"] == f"overlays/{e['pass_id']}_{e['tile']}.png", where, "url must be overlays/<pass_id>_<tile>.png")
            p = pass_by_id.get(e["pass_id"])
            rep.check(p is not None and p["used"], where, "overlay for an unknown or excluded pass")
            tile = tiles.get(e["tile"])
            if rep.check(tile is not None, where, "unknown tile"):
                b = tile["bbox"]
                corners = [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]
                rep.check(all(abs(c[0] - k[0]) <= 1e-6 and abs(c[1] - k[1]) <= 1e-6
                              for c, k in zip(e["coordinates"], corners)), where,
                          "coordinates must be the tile bbox corners: top-left, top-right, bottom-right, bottom-left")
            check_png(run / e["url"], rep, where)
        for path in sorted((run / "overlays").glob("*.png")):
            rel = path.relative_to(run).as_posix()
            rep.check(rel in referenced, rel, "overlay PNG not listed in overlays/index.json")
    stages_present = {o["stage"] for _, o in obs_rows}
    for s in sorted(stages_present):
        path = run / "hist" / f"{s}.png"
        if rep.check(path.exists(), f"hist/{s}.png", "histogram missing for a stage that has observations"):
            check_png(path, rep, f"hist/{s}.png")

    # 9. published outputs
    det = data.get("detectability.json")
    summaries_rows = data.get("field_summary.jsonl")
    summaries = {}
    if det:
        check_detectability(det, aoi, used, is_fixture, rep, recompute, passes)
    if summaries_rows is not None and det:
        for i, s in summaries_rows:
            where = f"field_summary.jsonl:{i}"
            if not rep.check(s["field_id"] not in summaries, where, f"duplicate field_id {s['field_id']}"):
                continue
            summaries[s["field_id"]] = s
            if not rep.check(s["field_id"] in field_by_id, where, f"unknown field_id {s['field_id']}"):
                continue
            check_summary(s, obs_by_field.get(s["field_id"], []), pass_by_id, det, aoi, rep, where, recompute)
        rep.check(set(summaries) == set(field_by_id), "field_summary.jsonl",
                  f"must have exactly one line per field ({len(summaries)} lines, {len(field_by_id)} fields)")
        counts = {}
        for s in summaries.values():
            counts[s["awd"]["verdict"]] = counts.get(s["awd"]["verdict"], 0) + 1
        rep.facts["verdicts"] = counts
        if is_fixture:
            rep.check(len(counts) == 3, "field_summary.jsonl", "fixtures must contain all three verdicts (SPEC B9)")
    story = data.get("story.json")
    if story and summaries and set(summaries) == set(field_by_id):
        expected = rules.story(aoi, props, summaries, len(used), story["run_id"], story.get("fixture"))
        for key in ("hero_tile", "hero_field_id", "headline", "counts"):
            rep.check(story[key] == expected[key], "story.json", f"{key} = {story[key]!r}, rule gives {expected[key]!r}")
    st_doc = data.get("states.json")
    if st_doc:
        expected = rules.states(list(field_by_id), passes, [o for _, o in obs_rows], st_doc["run_id"], st_doc.get("fixture"))
        for key in ("pass_ids", "field_ids", "states"):
            rep.check(st_doc[key] == expected[key], "states.json", f"{key} disagrees with passes/observations (B3.13)")
    dc = data.get("district_check.json")
    if dc and summaries:
        check_district(dc, props, summaries, rep)
    ck = data.get("checks.json")
    if ck:
        check_checks(ck, obs_rows, tiles, season, rep)
    claims = data.get("claims.sample.geojson")
    if claims:
        check_claims(claims, field_by_id, is_fixture, rep)


def check_headers(data: dict, rep: Report) -> bool:
    """2. headers: run_id and fixture flag agree everywhere. Returns whether the run is a fixture."""
    run_ids, fixture_flags = set(), set()
    for name, doc in data.items():
        if doc is None:
            continue
        items = [r for _, r in doc] if isinstance(doc, list) else [doc]
        for item in items:
            if isinstance(item, dict):
                run_ids.add(item.get("run_id"))
                fixture_flags.add(bool(item.get("fixture", False)))
    run_ids.discard(None)
    rep.check(len(run_ids) == 1, "run", f"run_id differs between files: {sorted(run_ids)}")
    is_fixture = fixture_flags == {True}
    rep.check(len(fixture_flags) == 1, "run", "some files are marked fixture and some are not")
    rep.facts["run_id"] = next(iter(run_ids)) if run_ids else None
    rep.facts["fixture"] = is_fixture
    return is_fixture


def check_aoi(aoi: dict, rep: Report):
    """3. aoi: tile ids, bboxes, season and stage order, the permanent NISAR gap. Returns (tiles by id, gaps)."""
    tiles = {t["id"]: t for t in aoi["tiles"]}
    rep.check(len(tiles) == len(aoi["tiles"]), "aoi.json", "duplicate tile id")
    for t in aoi["tiles"]:
        b = t["bbox"]
        rep.check(b[0] < b[2] and b[1] < b[3], "aoi.json", f"tile {t['id']}: bbox min must be below max")
    season, st = aoi["season"], aoi["stages"]
    rep.check(rules.parse_ms(season["start"]) < rules.parse_ms(st["mid_start"]) < rules.parse_ms(st["late_start"])
              < rules.parse_ms(season["end"]), "aoi.json", "need season.start < mid_start < late_start < season.end")
    rep.check(any((g["start"], g["end"]) == NISAR_GAP for g in aoi["gaps"]), "aoi.json",
              f"gaps must include the permanent NISAR gap {NISAR_GAP[0]}..{NISAR_GAP[1]}")
    gaps = aoi["gaps"]
    return tiles, gaps


def check_fields(features: list, tiles: dict, rep: Report) -> dict:
    """5. fields: unique ids, tile and district agree with aoi.json, label point inside, closed rings."""
    props = [f["properties"] for f in features]
    field_by_id = {p["field_id"]: f for p, f in zip(props, features)}
    rep.check(len(field_by_id) == len(features), "fields.geojson", "duplicate field_id")
    for f in features:
        p = f["properties"]
        where = f"fields.geojson:{p['field_id']}"
        tile = tiles.get(p["tile"])
        if not rep.check(tile is not None, where, f"unknown tile {p['tile']}"):
            continue
        rep.check(p["field_id"].startswith(p["tile"] + "-"), where, "field_id must start with its tile id")
        rep.check(p["district"] == tile["district"], where, f"district {p['district']!r} != tile district {tile['district']!r}")
        b = tile["bbox"]
        rep.check(b[0] <= p["lon"] <= b[2] and b[1] <= p["lat"] <= b[3], where, "label point outside its tile bbox")
        rep.check(rules.contains(f["geometry"], p["lon"], p["lat"]), where, "label point (lon, lat) is not inside the polygon")
        for poly in rules._rings_of(f["geometry"]):
            for ring in poly:
                rep.check(ring[0] == ring[-1], where, "polygon ring is not closed")
    rep.facts["fields"] = len(features)
    return field_by_id


def _validate_geo(run: pathlib.Path, aoi, fields_doc, data: dict, rep: Report):
    """Stage "geo": geo's hand-off (aoi.json + fields.geojson, plus fields.pmtiles if present), before any
    pipeline file exists. Runs the same aoi and fields checks as the other stages and nothing else."""
    pm = run / "fields.pmtiles"
    if pm.exists():
        try:
            with pm.open("rb") as f:
                rep.check(f.read(8) == PMTILES_MAGIC, "fields.pmtiles", "not a PMTiles v3 archive (bad magic bytes)")
        except OSError as exc:
            rep.error("fields.pmtiles", f"cannot read: {exc}")
    rep.facts["pmtiles"] = pm.exists()
    if not (aoi and fields_doc):
        return
    check_headers(data, rep)
    tiles, _ = check_aoi(aoi, rep)
    check_fields(fields_doc["features"], tiles, rep)


def check_granule(p, is_fixture, rep, where):
    g = p["granule_id"]
    if is_fixture:
        rep.check(g.startswith("SAMPLE_"), where, "fixture granule ids must start with SAMPLE_")
        g = g[len("SAMPLE_"):]
    else:
        rep.check(not g.startswith("SAMPLE_"), where, "T3: a real run cannot use SAMPLE_ granule ids")
    t = g.split("_")
    if len(t) != 18:
        rep.error(where, "granule_id does not have the 18 NISAR name fields")
        return
    dt = p["datetime"]
    start = f"{dt[0:4]}{dt[5:7]}{dt[8:10]}T{dt[11:13]}{dt[14:16]}{dt[17:19]}"
    rep.check(int(t[5]) == p["track"], where, f"track {p['track']} != granule {t[5]}")
    rep.check(t[6] == ("A" if p["direction"] == "ascending" else "D"), where, f"direction {p['direction']} != granule {t[6]}")
    rep.check(int(t[7]) == p["frame"], where, f"frame {p['frame']} != granule {t[7]}")
    rep.check(t[9][:2] == p["pol_mode"], where, f"pol_mode {p['pol_mode']} != granule polarization {t[9]}")
    rep.check(t[11] == start, where, f"datetime {dt} != granule start {t[11]}")
    rep.check(t[13] == p["crid"], where, f"crid {p['crid']} != granule {t[13]}")
    rep.check(p["pass_id"].startswith(f"{start[:8]}-T{t[5]}{t[6]}"), where, "pass_id must be <YYYYMMDD>-T<track><A|D>")


def check_png(path: pathlib.Path, rep: Report, where: str):
    try:
        with path.open("rb") as f:
            rep.check(f.read(8) == PNG_MAGIC, where, "not a PNG file")
    except OSError:
        rep.error(where, "file missing")


def check_detectability(det, aoi, used, is_fixture, rep, recompute, passes):
    where = "detectability.json"
    params, res = det["params"], det["results"]
    expected_dates = sorted((p["datetime"] for p in used), key=rules.parse_ms)
    rep.check(det["pass_dates"] == expected_dates, where, "pass_dates must be the used passes' datetimes, sorted")
    rep.check(params["stage_boundaries"] == aoi["stages"], where, "params.stage_boundaries must equal aoi.stages")
    tw = params["transplant_window"]
    rep.check(rules.parse_ms(tw["start"]) <= rules.parse_ms(tw["end"]), where, "transplant_window start after end")
    for key in ("awd_window_days_after_transplant", "cycle_days", "drained_fraction_of_cycle"):
        lo, hi = params[key]
        rep.check(lo <= hi, where, f"{key}: lower bound above upper bound")
    if not is_fixture:
        for key, src in det["param_sources"].items():
            rep.check(src["status"] != "needs_citation", where, f"param {key} still needs a citation (real run)")
    else:
        for key, src in det["param_sources"].items():
            if src["status"] == "needs_citation":
                rep.warn(where, f"param {key} needs a citation before a real run")
    n = len(det["pass_dates"])
    counts = {}
    for name in ("awd", "cf"):
        dist = res[name]["dist"]
        rep.check(len(dist) == n + 1, where, f"results.{name}.dist must have n+1 = {n + 1} entries")
        rep.check(abs(sum(dist) - 1) <= 1e-9, where, f"results.{name}.dist must sum to 1")
        counts[name] = [round(p * det["n_sim"]) for p in dist]
    ge = lambda name, k: rules.ge(counts[name], k)
    for k, key in ((1, "p_ge1"), (2, "p_ge2"), (3, "p_ge3")):
        rep.check(abs(res["awd"][key] - ge("awd", k)) <= 1e-12, where, f"results.awd.{key} disagrees with dist")
    for k, key in ((1, "p_ge1_false"), (2, "p_ge2_false")):
        rep.check(abs(res["cf"][key] - ge("cf", k)) <= 1e-12, where, f"results.cf.{key} disagrees with dist")
    k_star = rules.k_star_from(counts["cf"], params["cf_false_flag_max"])
    rep.check(res["k_star"] == k_star, where, f"k_star {res['k_star']} but the CF distribution gives {k_star}")
    expected_sentence = rules.sentence(n, res["k_star"], counts["awd"], counts["cf"], params["cf_false_flag_max"])
    rep.check(det["sentence"] == expected_sentence, where, f"sentence must be: {expected_sentence!r}")
    if recompute:
        fresh = rules.detectability(passes, params, det["n_sim"], det["seed"])
        rep.check(fresh["results"] == res, where, "--recompute: results differ from the reference simulation")


def check_summary(s, observations, pass_by_id, det, aoi, rep, where, recompute):
    params = det["params"]
    if recompute:
        expected = rules.field_summary(s["field_id"], observations, pass_by_id, params, aoi["stages"], det["n_sim"],
                                       det["seed"], s["run_id"], s.get("fixture"))
        rep.check(s == expected, where, "--recompute: summary differs from the reference rule "
                  + json.dumps({k: (s["awd"].get(k), expected["awd"].get(k)) for k in s["awd"] if s["awd"].get(k) != expected["awd"].get(k)}))
        return
    # Fast path: everything except the per-field simulation numbers.
    looks = []
    for o in observations:
        p = pass_by_id[o["pass_id"]]
        if p["used"] and o["inferred"]["state"] in ("flooded", "drained"):
            looks.append((rules.parse_ms(p["datetime"]), p["datetime"], o["stage"], o["inferred"]["state"]))
    looks.sort()
    a = s["awd"]
    a0, a1 = params["awd_window_days_after_transplant"]
    early_flooded = [lk for lk in looks if lk[2] == "early" and lk[3] == "flooded"]
    if early_flooded:
        t_ms, source = early_flooded[0][0], "inferred"
    else:
        tw0, tw1 = (rules.parse_ms(params["transplant_window"][k]) for k in ("start", "end"))
        t_ms, source = tw0 + (tw1 - tw0) // 2, "assumed"
    window = {"start": rules.fmt_dt(t_ms + a0 * rules.DAY_MS), "end": rules.fmt_dt(t_ms + a1 * rules.DAY_MS), "source": source}
    rep.check(a["window"] == window, where, f"window {a['window']} but the rule gives {window}")
    ws, we = rules.parse_ms(window["start"]), rules.parse_ms(window["end"])
    inside = [lk for lk in looks if ws <= lk[0] < we]
    n, d = len(inside), sum(1 for lk in inside if lk[3] == "drained")
    rep.check(a["clear_looks"] == n, where, f"clear_looks {a['clear_looks']} but observations give {n}")
    rep.check(a["drained_hits"] == d, where, f"drained_hits {a['drained_hits']} but observations give {d}")
    if n == 0:
        rep.check(a["p_catch_ge1_if_awd"] == 0 and a["k_star"] is None, where, "no clear looks: p_catch must be 0 and k_star null")
    elif a["k_star"] is not None:
        rep.check(a["k_star"] <= n, where, "k_star cannot exceed clear_looks")
    verdict = rules.awd_verdict(n, d, a["p_catch_ge1_if_awd"], a["k_star"], params["awd_miss_max"])
    rep.check(a["verdict"] == verdict, where, f"T6: verdict {a['verdict']} but the rule gives {verdict}")
    reason = rules.awd_reason(verdict, n, d, a["p_catch_ge1_if_awd"], a["k_star"])
    rep.check(a["reason"] == reason, where, f"reason must be {reason!r}")
    early = [lk for lk in looks if lk[2] == "early"]
    signal, dsr_reason = rules.dsr_signal(early, params["dsr_min_early_looks"], aoi["stages"]["mid_start"])
    rep.check(s["dsr"] == {"signal": signal, "reason": dsr_reason}, where,
              f"dsr {s['dsr']} but the rule gives {signal!r}: {dsr_reason!r}")


def check_district(dc, props, summaries, rep):
    where = "district_check.json"
    seen = set()
    for row in dc["rows"]:
        rep.check(row["district"] not in seen, where, f"district {row['district']} listed twice")
        seen.add(row["district"])
        mine = [p for p in props if p["district"] == row["district"]]
        if not mine:
            rep.check(row["tile_rice_ha"] is None and row["tile_dsr_signal_ha"] is None and row["tile_dsr_signal_frac"] is None,
                      where, f"{row['district']} has no tile, so its tile_* values must be null")
            continue
        rice = sum(p["area_ha"] for p in mine)
        dsr = sum(p["area_ha"] for p in mine if summaries[p["field_id"]]["dsr"]["signal"] == "dsr_signal")
        rep.check(row["tile_rice_ha"] is not None and abs(row["tile_rice_ha"] - rice) <= 0.01, where,
                  f"{row['district']}: tile_rice_ha {row['tile_rice_ha']} but fields sum to {rice:.2f}")
        rep.check(row["tile_dsr_signal_ha"] is not None and abs(row["tile_dsr_signal_ha"] - dsr) <= 0.01, where,
                  f"{row['district']}: tile_dsr_signal_ha {row['tile_dsr_signal_ha']} but fields give {dsr:.2f}")
        if rice:
            rep.check(row["tile_dsr_signal_frac"] is not None and abs(row["tile_dsr_signal_frac"] - dsr / rice) <= 1e-3,
                      where, f"{row['district']}: tile_dsr_signal_frac must be tile_dsr_signal_ha / tile_rice_ha")
    for d in {p["district"] for p in props} - seen:
        rep.error(where, f"district {d} has fields but no row")
    rep.check("signal" in dc["note"].lower() and "not a district" in dc["note"].lower(), where,
              "note must say a tile is not a district and that DSR is a signal, not proof")


def check_checks(ck, obs_rows, tiles, season, rep):
    where = "checks.json"
    for s, value in ck["season_shape"]["pct_flooded_by_stage"].items():
        clear = [o for _, o in obs_rows if o["stage"] == s and o["inferred"]["state"] != "uncertain"]
        if not clear:
            rep.check(value is None, where, f"stage {s} has no clear looks, so its value must be null")
            continue
        expected = 100 * sum(1 for o in clear if o["inferred"]["state"] == "flooded") / len(clear)
        rep.check(value is not None and abs(value - expected) <= 0.01, where,
                  f"pct_flooded_by_stage.{s} = {value} but observations give {expected:.2f}")
    op = ck["opera"]
    if op:
        rep.check("3 ha" in op["note"], where, "opera.note must carry the 30 m / 3 ha caveat")
        rep.check(op["n_dates"] == len({p["date"] for p in op["pairs"]}), where, "opera.n_dates must count distinct pair dates")
        for p in op["pairs"]:
            rep.check(p["tile"] in tiles, where, f"opera pair for unknown tile {p['tile']}")
            if "opera_date" in p:
                gap_days = abs(rules.parse_ms(p["opera_date"]) - rules.parse_ms(p["date"])) / rules.DAY_MS
                rep.check(gap_days <= 2, where, f"opera_date {p['opera_date']} is more than 2 days from {p['date']}")


def check_claims(claims, field_by_id, is_fixture, rep):
    where = "claims.sample.geojson"
    ids = [c["properties"].get("claim_id") for c in claims["features"]]
    rep.check(None not in ids, where, "every sample claim needs a claim_id")
    rep.check(len(ids) == len(set(ids)), where, "claim_id must be unique")
    rep.check(all(c["properties"]["synthetic"] for c in claims["features"]), where, "sample claims must all be synthetic")
    rep.check(len(claims["features"]) == 60, where, f"the sample has exactly 60 claims (has {len(claims['features'])})")
    for c in claims["features"]:
        fid = c["properties"].get("field_id")
        if fid is not None:
            rep.check(fid in field_by_id, where, f"{c['properties']['claim_id']} names unknown field {fid}")


# ------------------------------------------------------------------------------------------------ fixtures root
def validate_fixture_root(root: pathlib.Path, schemas: Schemas, rep: Report, recompute: bool):
    validate_run(root / "run", schemas, rep, "published", recompute)
    guarded("api", rep, _validate_api, root, schemas, rep)


def _validate_api(root: pathlib.Path, schemas: Schemas, rep: Report):
    run = root / "run"
    live = load_json(root / "live.json", rep, "live.json") if (root / "live.json").exists() else None
    if rep.check(live is not None, "live.json", "missing"):
        for err in schemas.errors("live", live):
            rep.error("live.json", err)
        rep.check(live.get("fixture") is True and live.get("run_id") == "fixture", "live.json", "must point at run 'fixture'")
    api = root / "api"
    if not rep.check(api.is_dir(), "api", "missing"):
        return
    names = {p.name for p in api.glob("*.json")}
    docs = {}
    for name in sorted(names):
        doc = load_json(api / name, rep, f"api/{name}")
        if doc is None:
            continue
        if not isinstance(doc, dict):
            rep.error(f"api/{name}", "must be a JSON object")
            continue
        docs[name] = doc
        if name in API_FILES:
            schema = API_FILES[name]
        elif name.startswith("field."):
            schema = "api/field_detail"
        elif name.startswith("error."):
            schema = "api/error"
        else:
            rep.error(f"api/{name}", "unexpected file (no matching API schema)")
            continue
        for err in schemas.errors(schema, doc):
            rep.error(f"api/{name}", err)
        if schema not in ("api/error", "api/audit_request"):
            rep.check(doc.get("fixture") is True, f"api/{name}", "T8: fixture responses must carry fixture: true")
    for name in API_FILES:
        rep.check(name in names, f"api/{name}", "missing")
    rep.check(any(n.startswith("field.") for n in names), "api/field.<id>.json", "missing")

    def run_json(name):
        try:
            return parse((run / name).read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            return None

    for api_name, run_name in (("story.json", "story.json"), ("passes.json", "passes.json"),
                               ("detectability.json", "detectability.json"), ("provenance.json", "provenance.json"),
                               ("states.json", "states.json")):
        if api_name in docs:
            rep.check(docs[api_name] == run_json(run_name), f"api/{api_name}", f"must equal run/{run_name}")
    if "checks.json" in docs:
        ck, dc = run_json("checks.json"), run_json("district_check.json")
        if ck:
            rep.check(docs["checks.json"]["season_shape"] == ck["season_shape"] and docs["checks.json"]["opera"] == ck["opera"]
                      and docs["checks.json"]["district"] == dc, "api/checks.json", "must merge run/checks.json and run/district_check.json")
    fields_doc = run_json("fields.geojson") or {"features": []}
    summaries = {}
    try:
        for line in (run / "field_summary.jsonl").read_text(encoding="utf-8").splitlines():
            s = parse(line)
            summaries[s["field_id"]] = s
    except (OSError, ValueError, RecursionError):
        pass
    if "fields.json" in docs:
        page = docs["fields.json"]
        rep.check(page["total"] == len(fields_doc["features"]), "api/fields.json", "total must equal the number of fields")
        ids = [r["field_id"] for r in page["fields"]]
        rep.check(ids == sorted(ids), "api/fields.json", "fields must be ordered by field_id")
        for r in page["fields"]:
            s = summaries.get(r["field_id"])
            if s:
                rep.check(r["awd_verdict"] == s["awd"]["verdict"] and r["dsr_signal"] == s["dsr"]["signal"]
                          and r["p_catch"] == s["awd"]["p_catch_ge1_if_awd"], "api/fields.json",
                          f"{r['field_id']}: row disagrees with field_summary.jsonl")
    if "audit.request.json" in docs and "audit.response.json" in docs:
        body = (api / "audit.request.json").read_bytes()
        resp = docs["audit.response.json"]
        expected = rules.rank(body, fields_doc["features"], summaries, resp["run_id"], resp["created_at"], resp["fixture"])
        rep.check(resp == expected, "api/audit.response.json", "golden ranking differs from rules.rank on audit.request.json")
        n = len(resp["ranked"])
        rep.check(sum(1 for r in resp["ranked"] if r["pick"] == "random") == (n + 2) // 5, "api/audit.response.json",
                  "T7: random picks must be 20% of the ranked list")
    meta = docs.get("meta.json")
    if meta:
        rep.check(meta["counts"]["fields"] == len(fields_doc["features"]), "api/meta.json", "counts.fields disagrees with run")
        limits = meta["limits_text"]
        rep.check(limits.startswith("No 2026 ground truth in Punjab yet."), "api/meta.json", "limits_text must be the SPEC D8 Limits box")


# ------------------------------------------------------------------------------------------------ main
def discover(paths: list[str]) -> list[pathlib.Path]:
    if paths:
        return [pathlib.Path(p) for p in paths]
    repo = HERE.parent
    targets = [HERE / "fixtures"]
    arts = repo / "artifacts"
    if arts.is_dir():
        targets += sorted(p for p in arts.iterdir() if p.is_dir() and (p / "aoi.json").exists())
    return targets


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Validate Mudskipper fixtures and run artifacts (T1).")
    ap.add_argument("paths", nargs="*", help="run directories or a fixtures root (default: fixtures + artifacts/*)")
    ap.add_argument("--stage", choices=["auto", "geo", "pipeline", "published"], default="auto",
                    help="auto: published if field_summary.jsonl exists, else pipeline; geo: aoi.json + fields only")
    ap.add_argument("--recompute", action="store_true", help="rerun the reference simulation and compare exactly")
    ap.add_argument("--quiet", action="store_true", help="print only problems and the final line")
    args = ap.parse_args(argv)

    schemas = Schemas()
    reports = []
    for target in discover(args.paths):
        rep = Report(str(target))
        if (target / "run").is_dir() and (target / "api").is_dir():
            validate_fixture_root(target, schemas, rep, args.recompute)
        elif (target / "aoi.json").exists():
            validate_run(target, schemas, rep, args.stage, args.recompute)
        else:
            sys.stderr.write(f"{target}: not a run directory (no aoi.json) or a fixtures root (no run/ and api/)\n")
            return 2
        reports.append(rep)

    bad = 0
    for rep in reports:
        status = "FAIL" if rep.errors else "ok"
        bad += bool(rep.errors)
        facts = ", ".join(f"{k}={v}" for k, v in rep.facts.items())
        print(f"[{status}] {rep.target}  ({facts})")
        for e in rep.errors:
            print(f"    error: {e}")
        if not args.quiet:
            for w in rep.warnings:
                print(f"    warning: {w}")
    total_e = sum(len(r.errors) for r in reports)
    total_w = sum(len(r.warnings) for r in reports)
    print(f"validate: {len(reports)} target(s), {total_e} error(s), {total_w} warning(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
