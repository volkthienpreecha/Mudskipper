"""Spec tests for pipeline/ (LANE ISHAAN: schema, determinism, gap exclusion, one CRID,
Freeman-Durden known answer, linear-power averaging) plus the B3.4 uncertain rule.
Run from repo root:  .venv\\Scripts\\python.exe -m pytest pipeline\\tests -q
Artifact tests run against artifacts/$RUN_ID (default r01) and skip if it is missing.
Exported runs can exercise the read-only contract checks; internal rerun checks
require zonal.jsonl and the original input caches.
"""
import datetime as dt, hashlib, json, os, subprocess, sys
import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from freeman_durden import freeman_durden  # noqa: E402

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join(ROOT, "artifacts", RUN)
GAP = (dt.datetime(2026, 7, 27, 22, 3, 25), dt.datetime(2026, 8, 10, 0, 55, 27))
need_art = pytest.mark.skipif(not os.path.exists(os.path.join(ART, "observations.jsonl")), reason="no artifacts")
need_internal = pytest.mark.skipif(not os.path.exists(os.path.join(ART, "zonal.jsonl")), reason="no internal zonal inputs")


def passes():
    return json.load(open(os.path.join(ART, "passes.json")))["passes"]


def obs():
    with open(os.path.join(ART, "observations.jsonl")) as f:
        for line in f:
            yield json.loads(line)


# ---------- Freeman-Durden on synthetic covariances with known answers
def test_fd_pure_surface_plus_volume():
    fs, beta, fv = 2.0, 0.3, 0.6
    ps, pd, pv = freeman_durden(fs * beta ** 2 + fv, fv / 3, fs + fv, fs * beta + fv / 3)
    assert ps == pytest.approx(fs * (1 + beta ** 2)) and pd == pytest.approx(0, abs=1e-9)
    assert pv == pytest.approx(8 * fv / 3)


def test_fd_pure_double_bounce_plus_volume():
    fd, alpha, fv = 1.0, -0.5 + 0.2j, 0.6
    ps, pd, pv = freeman_durden(fd * abs(alpha) ** 2 + fv, fv / 3, fd + fv, fd * alpha + fv / 3)
    assert pd == pytest.approx(fd * (1 + abs(alpha) ** 2)) and ps == pytest.approx(0, abs=1e-9)


def test_fd_conserves_power_and_clips_negatives():
    rng = np.random.default_rng(0)
    hh, hv, vv = rng.uniform(0.01, 1, (3, 500))
    c = rng.uniform(-0.3, 0.3, 500) + 1j * rng.uniform(-0.3, 0.3, 500)
    ps, pd, pv = freeman_durden(hh, hv, vv, c)
    assert (ps >= 0).all() and (pd >= 0).all() and (pv >= 0).all()
    ok = (hh - 3 * hv > 0) & (vv - 3 * hv > 0) & (ps > 0) & (pd > 0)
    assert np.allclose((ps + pd + pv)[ok], (hh + 2 * hv + vv)[ok])


# ---------- linear-power averaging
def test_mean_in_linear_power_not_db():
    lin = np.array([1.0, 0.01])  # 0 dB and -20 dB
    from zonal import db
    assert db(lin.mean()) == pytest.approx(10 * np.log10(0.505), abs=1e-3)  # -2.97 dB
    assert db(lin.mean()) != pytest.approx(np.mean(10 * np.log10(lin)))     # not -10 dB


# ---------- passes.json
@need_art
def test_no_used_pass_inside_gap():
    for p in passes():
        t = dt.datetime.fromisoformat(p["datetime"].rstrip("Z"))
        if GAP[0] <= t <= GAP[1]:
            assert not p["used"], p["pass_id"]


@need_art
def test_one_crid_per_series():
    by_track = {}
    for p in passes():
        if p["used"]:
            by_track.setdefault(p["track"], set()).add(p["crid"])
    assert by_track and all(len(c) == 1 for c in by_track.values()), by_track


@need_art
def test_excluded_passes_have_reasons_and_real_granules():
    for p in passes():
        assert p["granule_id"].startswith("NISAR_L2_") and "_GCOV_" in p["granule_id"]
        assert p["used"] or p["excluded_reason"]


# ---------- observations.jsonl (B3.4)
@need_art
def test_observation_schema_and_uncertain_rule():
    used = {p["pass_id"] for p in passes() if p["used"]}
    n = 0
    for r in obs():
        n += 1
        assert r["v"] == 1 and r["run_id"] == RUN and r["pass_id"] in used
        assert r["stage"] in ("early", "mid", "late")
        inf = r["inferred"]
        assert inf["state"] in ("flooded", "drained", "uncertain") and inf["method"] in ("hhhv_v1", "fd_gmm_v1")
        assert set(r["observed"]) >= {"hh_db", "hv_db", "hh_hv_db"}
        pf = inf["p_flooded"]
        if pf is None:
            assert inf["state"] == "uncertain"
        elif r["valid_frac"] < 0.6 or 0.35 < pf < 0.65:
            assert inf["state"] == "uncertain"
        else:
            assert inf["state"] == ("flooded" if pf >= 0.65 else "drained")
    assert n > 0


# ---------- determinism: rerunning classify gives an identical file
@need_internal
def test_classify_is_deterministic(tmp_path):
    path = os.path.join(ART, "observations.jsonl")
    before = hashlib.sha256(open(path, "rb").read()).hexdigest()
    env = dict(os.environ, RUN_ID=RUN)
    subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "classify.py")], cwd=ROOT, env=env,
                   check=True, capture_output=True)
    after = hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert before == after


# ---------- fill_passes / checks / provenance completeness
@need_art
def test_used_passes_have_pixel_and_terms():
    for p in passes():
        if p["used"]:
            assert p["pixel_m"] in (10.0, 20.0), p["pass_id"]
            assert set(p["covariance_terms"]) >= {"HHHH", "HVHV"}, p["pass_id"]
            vf = p["valid_fraction_by_tile"]
            assert vf and all(0 <= v <= 1 for v in vf.values()), p["pass_id"]


@need_internal
def test_checks_schema_passes():
    c = json.load(open(os.path.join(ART, "checks.json")))
    assert c["schema"]["status"] == "PASS"
    for k in ("harvest", "early_low", "flip_rate", "never_drained_late"):
        assert c[k]["status"] in ("PASS", "WARN")


@need_internal
def test_provenance_lists_sentinel1_when_fused():
    fused = any("fused_sentinel1" in r["flags"] for r in obs())
    prov = json.load(open(os.path.join(ART, "provenance.json")))
    if fused:
        assert prov["ancillary"]["sentinel1_rtc"]["scenes"]


# ---------- export: field attributes come from the right segment (label N -> array slot N-1)
@need_internal
def test_export_field_area_matches_segment():
    exp = os.path.join(ROOT, "artifacts", "r01v1", "fields.geojson")
    if not os.path.exists(exp):
        pytest.skip("no contract export")
    feats = json.load(open(exp))["features"]
    segs = {}
    for f in feats[::97]:
        p = f["properties"]; t = p["tile"]; i = int(p["field_id"].split("-")[1])
        if t not in segs:
            segs[t] = np.load(os.path.join(ROOT, "data", f"segments_{t}.npz"))
        assert abs(p["area_ha"] - max(round(float(segs[t]["area_ha"][i - 1]), 3), 0.5)) < 1e-3, p["field_id"]


@need_art
def test_rice_mask_respected_in_export():
    exp = os.path.join(ROOT, "artifacts", "r01v1", "fields.geojson")
    if not os.path.exists(exp):
        pytest.skip("no contract export")
    assert all(f["properties"]["rice_mask_frac"] >= 0.5 for f in json.load(open(exp))["features"])
