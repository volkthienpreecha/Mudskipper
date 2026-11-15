#!/usr/bin/env python3
"""Build a rehearsal run: the real geometry of a geo hand-off at full scale, with SAMPLE radar data.

    python3 platform/scripts/rehearsal/make_rehearsal.py                     # artifacts/r01 -> platform/.rehearsal/x01
    python3 platform/scripts/rehearsal/make_rehearsal.py --src DIR --out DIR --run-id x01
    python3 platform/scripts/rehearsal/make_rehearsal.py --series both       # + descending track 135 (20 used passes)
    python3 platform/scripts/rehearsal/make_rehearsal.py --cap 5000          # pad to the 5,000-field cap (local only)

Why: the platform has only ever served the 300-field fixture run. The real run has ~4,600 FTW fields, so
this builds a run of the same size and shape that the real publish pipeline (compute-run, district table,
validate --recompute, bundle, site) and the deployed API can be measured on, without inventing anything that
could be mistaken for data:

- run_id starts with `x` (rehearsal) and every file carries `"fixture": true`, so the validator treats it as
  sample data and the app shows the SAMPLE DATA badge (T8);
- aoi.json, fields.geojson and fields.pmtiles are geo's real hand-off (copied from --src, never modified;
  only the run_id is re-stamped and `fixture: true` added; the PMTiles archive is copied byte for byte);
- passes are the real dates and geometry of the planned series (DECISIONS.md D-003, K-113, pipeline/STATE.md):
  ascending track 84, frame 17, CRID P05023, HH/HV, Jun 20 ... Oct 18 every 12 days, Aug 7 lost to the gap.
  Granule ids start with `SAMPLE_`, so they can never be mistaken for real ones (T3);
- observations (one per field per used pass), overlays, histograms and checks.json are drawn by the same
  hidden-truth model as contracts/make_fixtures.py (stdlib, seeded, deterministic). checks.json has no OPERA
  comparison (`opera: null`): nothing here pretends to be an independent cross-check;
- claims.sample.geojson comes from geo/claims_sample.py on these fields (60 SYNTHETIC claims), unless
  --no-claims; core's outputs and district_check.json are left to `publish --run` (step 1).

`--cap N` pads the run to N fields with copies of real polygons shifted north by 2 km and renumbered (only to
measure headroom at the B3.3 cap; such a run is never published). Output is byte-identical on reruns (T2).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "contracts"))
import make_fixtures as mf  # noqa: E402  (stdlib only: truth model, PNG and JSON writers)
import rules  # noqa: E402

SEED = 20261114
CREATED_AT = "2026-11-15T00:00:00Z"
GIT_SHA = "fixture"  # the schema allows a commit sha or "fixture"; a rehearsal is fixture data

# Ascending track 84 frame 17 (D-003): 10 DH passes, 12-day cadence, Aug 7 lost to the gap.
# Times follow the fixture's track-84 pass (00:21:29Z start, 35 s granule); cycles count up by one per 12 days.
ASC_DATES = ["2026-06-20", "2026-07-02", "2026-07-14", "2026-07-26", "2026-08-19", "2026-08-31",
             "2026-09-12", "2026-09-24", "2026-10-06", "2026-10-18"]
ASC_FIRST_CYCLE = 23
# Descending track 135 frame 73 (D-003): 6 DH + 4 QP passes; only for --series both (upper bound of ~20 looks).
DESC = [("2026-06-23", "DH"), ("2026-07-05", "DH"), ("2026-07-17", "DH"), ("2026-08-10", "DH"),
        ("2026-08-22", "QP"), ("2026-09-03", "QP"), ("2026-09-15", "QP"), ("2026-09-27", "QP"),
        ("2026-10-09", "DH"), ("2026-10-21", "DH")]
DH_TERMS = ["HHHH", "HVHV"]


def granule(cycle: int, track: int, direction: str, frame: int, mode: str, ymd: str, t0: str, t1: str) -> str:
    bw, pol = ("2005", "QPDH") if mode == "QP" else ("4005", "DHDH")
    return (f"SAMPLE_NISAR_L2_PR_GCOV_{cycle:03d}_{track:03d}_{direction}_{frame:03d}_{bw}_{pol}_A_"
            f"{ymd}T{t0}_{ymd}T{t1}_P05023_N_F_J_001")


def build_passes(tiles: list[dict], series: str) -> list[dict]:
    rng = rules.Mulberry32(rules.derive(SEED, "rehearsal-passes"))
    out = []

    def add(date, cycle, track, direction, frame, mode, t0, t1):
        ymd = date.replace("-", "")
        hh, mm, ss = t0[:2], t0[2:4], t0[4:]
        out.append({
            "pass_id": f"{ymd}-T{track:03d}{direction}",
            "granule_id": granule(cycle, track, direction, frame, mode, ymd, t0, t1),
            "datetime": f"{date}T{hh}:{mm}:{ss}Z",
            "direction": "ascending" if direction == "A" else "descending",
            "track": track, "frame": frame, "pol_mode": mode,
            # Every pass is classified with hhhv_v1 (one method per series), so only the diagonal terms are listed.
            "covariance_terms": DH_TERMS, "crid": "P05023", "maturity": "provisional",
            "pixel_m": 10 if mode == "DH" else 20,
            "valid_fraction_by_tile": {t["id"]: round(0.95 + rng() * 0.045, 3) for t in tiles},
            "used": True, "excluded_reason": None,
        })

    for i, date in enumerate(ASC_DATES):
        add(date, ASC_FIRST_CYCLE + i, 84, "A", 17, "DH", "002129", "002204")
    if series == "both":
        for date, mode in DESC:
            cycle = 23 + (rules.parse_ms(date) - rules.parse_ms("2026-06-23")) // (12 * rules.DAY_MS)
            add(date, cycle, 135, "D", 73, mode, "134734", "134809")
    out.sort(key=lambda p: (rules.parse_ms(p["datetime"]), p["pass_id"]))
    return out


def stamp(doc: dict, run_id: str) -> dict:
    """Re-stamp a geo document: run_id and fixture right after v, everything else unchanged."""
    rest = {k: v for k, v in doc.items() if k not in ("v", "run_id", "fixture")}
    return {"v": 1, "run_id": run_id, "fixture": True, **rest}


def pad_to_cap(features: list[dict], cap: int) -> list[dict]:
    """Copies of real polygons shifted 0.018 deg north (~2 km), renumbered after each tile's last id."""
    if cap <= len(features):
        return features
    by_tile: dict[str, list[dict]] = {}
    for f in features:
        by_tile.setdefault(f["properties"]["tile"], []).append(f)
    extra, k = [], 0
    while len(features) + len(extra) < cap:
        src = features[k % len(features)]
        k += 1
        tile = src["properties"]["tile"]
        n = len(by_tile[tile]) + sum(1 for e in extra if e["properties"]["tile"] == tile) + 1

        def shift(coords):
            if isinstance(coords[0], (int, float)):
                return [coords[0], round(coords[1] + 0.018, 7)]
            return [shift(c) for c in coords]

        g = {"type": src["geometry"]["type"], "coordinates": shift(src["geometry"]["coordinates"])}
        p = dict(src["properties"], field_id=f"{tile}-{n:05d}", lat=round(src["properties"]["lat"] + 0.018, 7))
        extra.append({"type": "Feature", "geometry": g, "properties": p})
    return sorted(features + extra, key=lambda f: f["properties"]["field_id"])


def observe(features: list[dict], passes: list[dict], stages: dict, run_id: str) -> list[dict]:
    """One line per field per used pass from the fixture generator's hidden-truth model (never written)."""
    lines = []
    for f in features:
        props = f["properties"]
        fid = props["field_id"]
        kind, drained = mf.truth_model(fid)
        rng = rules.Mulberry32(rules.derive(SEED, "rehearsal-obs:" + fid))
        for p in passes:
            stage = rules.stage_of(p["datetime"], stages)
            truth = "drained" if drained(rules.days(p["datetime"])) else "flooded"
            acc = mf.PARAMS["per_pass_accuracy"][stage]
            label = truth if rng() < acc else ("flooded" if truth == "drained" else "drained")
            if rng() < (0.5 if kind == "noisy" else 0.1):
                p_fl = 0.36 + rng() * 0.28
            elif label == "flooded":
                p_fl = 0.66 + rng() * 0.335
            else:
                p_fl = 0.005 + rng() * 0.335
            p_fl = round(p_fl, 4)
            n_px = max(1, round(props["area_ha"] * 10000 / (p["pixel_m"] ** 2)))
            valid = round(0.4 + rng() * 0.6 if rng() < 0.04 else 0.88 + rng() * 0.12, 3)
            flags = []
            if valid < rules.VALID_FRAC_MIN:
                flags.append("low_valid_frac")
            if n_px < 10:
                flags.append("few_pixels")
            flags.append("dual_pol_only")
            hh_f, hv_f, _ = mf.MEANS[(stage, "flooded")]
            hh_d, hv_d, _ = mf.MEANS[(stage, "drained")]
            hh = round(hh_d + p_fl * (hh_f - hh_d) + mf.gauss(rng, 0, 0.8), 2)
            hv = round(hv_d + p_fl * (hv_f - hv_d) + mf.gauss(rng, 0, 0.8), 2)
            lines.append({"v": 1, "run_id": run_id, "fixture": True, "field_id": fid, "pass_id": p["pass_id"],
                          "n_px": n_px, "valid_frac": valid,
                          "observed": {"hh_db": hh, "hv_db": hv, "hh_hv_db": round(hh - hv, 2)}, "stage": stage,
                          "inferred": {"state": rules.state_from(p_fl, valid), "p_flooded": p_fl,
                                       "confidence": round(rules.confidence_from(p_fl), 4), "method": "hhhv_v1"},
                          "flags": flags})
    return lines


def outer_rings(geometry: dict) -> list:
    return [geometry["coordinates"][0]] if geometry["type"] == "Polygon" else [p[0] for p in geometry["coordinates"]]


def render_overlay(path: pathlib.Path, tile: dict, features: list[dict], obs: dict, pass_id: str, size: int = 1000):
    """HH/HV false colour of each field's bounding box on one pass (SAMPLE), like the fixture overlays."""
    minx, miny, maxx, maxy = tile["bbox"]
    canvas = [bytearray(size * 4) for _ in range(size)]
    for f in features:
        o = obs[(f["properties"]["field_id"], pass_id)]["observed"]
        comps = [mf.lin(o["hh_db"]), mf.lin(o["hv_db"]) * 3, mf.lin(o["hh_db"]) * 0.6]
        top = max(comps)
        px = bytes([*(int(40 + 215 * (c / top) ** 0.5) for c in comps), 235])
        for ring in outer_rings(f["geometry"]):
            xs, ys = [pt[0] for pt in ring], [pt[1] for pt in ring]
            c0 = max(int((min(xs) - minx) / (maxx - minx) * size), 0)
            c1 = min(int((max(xs) - minx) / (maxx - minx) * size), size - 1)
            r0 = max(int((maxy - max(ys)) / (maxy - miny) * size), 0)
            r1 = min(int((maxy - min(ys)) / (maxy - miny) * size), size - 1)
            for r in range(r0, r1 + 1):
                canvas[r][c0 * 4:(c1 + 1) * 4] = px * (c1 - c0 + 1)
    mf.write_png(path, size, size, canvas)


def season_checks(observations: list[dict], run_id: str) -> dict:
    pct = {}
    for st in rules.STAGES:
        clear = [o for o in observations if o["stage"] == st and o["inferred"]["state"] != "uncertain"]
        fl = sum(1 for o in clear if o["inferred"]["state"] == "flooded")
        pct[st] = round(100 * fl / len(clear), 2) if clear else None
    ok = None not in pct.values() and pct["late"] < pct["mid"]
    return {"v": 1, "run_id": run_id, "fixture": True,
            "season_shape": {"pct_flooded_by_stage": pct, "pass": ok,
                             "rule": "Flooded share should fall from mid season to late season as fields are drained "
                                     "before harvest; pass is true when late < mid."},
            "opera": None}


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(src: pathlib.Path, out: pathlib.Path, run_id: str, series: str, cap: int, claims: bool) -> dict:
    aoi = stamp(json.loads((src / "aoi.json").read_text(encoding="utf-8")), run_id)
    fields_doc = json.loads((src / "fields.geojson").read_text(encoding="utf-8"))
    features = pad_to_cap(fields_doc["features"], cap)
    if len(features) > 5000:
        raise SystemExit(f"{len(features)} fields is over the B3.3 cap of 5,000")
    head = {"type": "FeatureCollection", **stamp(fields_doc, run_id)}
    head.pop("features")

    if out.exists():
        shutil.rmtree(out)
    (out / "overlays").mkdir(parents=True)
    (out / "hist").mkdir()
    (out / "aoi.json").write_text(mf.dump(aoi), encoding="utf-8")
    (out / "fields.geojson").write_text(mf.dump_collection(head, features), encoding="utf-8")
    if (src / "fields.pmtiles").exists() and cap <= len(fields_doc["features"]):
        shutil.copyfile(src / "fields.pmtiles", out / "fields.pmtiles")

    passes = build_passes(aoi["tiles"], series)
    for p in passes:
        assert not rules.in_gap(p["datetime"], aoi["gaps"]), p
    observations = observe(features, passes, aoi["stages"], run_id)
    obs = {(o["field_id"], o["pass_id"]): o for o in observations}

    entries = []
    for tile in aoi["tiles"]:
        mine = [f for f in features if f["properties"]["tile"] == tile["id"]]
        minx, miny, maxx, maxy = tile["bbox"]
        for p in passes:
            name = f"{p['pass_id']}_{tile['id']}.png"
            render_overlay(out / "overlays" / name, tile, mine, obs, p["pass_id"])
            entries.append({"pass_id": p["pass_id"], "tile": tile["id"], "url": f"overlays/{name}",
                            "coordinates": [[minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny]]})
    entries.sort(key=lambda e: (e["pass_id"], e["tile"]))
    for st in rules.STAGES:
        mf.render_hist(out / "hist" / f"{st}.png", st, observations)

    (out / "passes.json").write_text(mf.dump({"v": 1, "run_id": run_id, "fixture": True, "passes": passes}), encoding="utf-8")
    (out / "observations.jsonl").write_text(mf.dump_jsonl(observations), encoding="utf-8")
    (out / "overlays" / "index.json").write_text(
        mf.dump({"v": 1, "run_id": run_id, "fixture": True, "overlays": entries}), encoding="utf-8")
    (out / "checks.json").write_text(mf.dump(season_checks(observations, run_id)), encoding="utf-8")

    if claims:
        subprocess.run(["uv", "run", "--frozen", "python", "claims_sample.py", "--run-id", run_id,
                        "--run-dir", str(out)], cwd=REPO / "geo", check=True)

    artifacts = [{"path": p.relative_to(out).as_posix(), "sha256": sha256(p)}
                 for p in sorted(out.rglob("*")) if p.is_file()]
    provenance = {"v": 1, "run_id": run_id, "fixture": True, "git_sha": GIT_SHA, "created_at": CREATED_AT,
                  "granules": [{"granule_id": p["granule_id"], "crid": p["crid"],
                                "subset_sha256": hashlib.sha256(f"SAMPLE subset {p['granule_id']}".encode()).hexdigest()}
                               for p in passes],
                  "artifacts": artifacts,
                  "decomposition_check": {"reference": "SAMPLE: rehearsal run, no decomposition (HH/HV only)",
                                          "max_abs_diff_db": None}}
    (out / "provenance.json").write_text(mf.dump(provenance), encoding="utf-8")
    return {"run_id": run_id, "fields": len(features), "passes": len(passes), "observations": len(observations),
            "overlays": len(entries), "pmtiles": (out / "fields.pmtiles").exists(), "claims": claims}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", default=str(REPO / "artifacts" / "r01"), help="geo hand-off to copy (never modified)")
    ap.add_argument("--out", help="default platform/.rehearsal/<run_id>")
    ap.add_argument("--run-id", default="x01")
    ap.add_argument("--series", choices=["a084", "both"], default="a084")
    ap.add_argument("--cap", type=int, default=0, help="pad to this many fields (local headroom runs only)")
    ap.add_argument("--no-claims", action="store_true", help="skip geo/claims_sample.py (needs uv + geo's lockfile)")
    args = ap.parse_args(argv)
    if not args.run_id.startswith("x"):
        raise SystemExit("rehearsal run ids start with x (x01, x02, ...), so they are never mistaken for a real run")
    src = pathlib.Path(args.src).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else REPO / "platform" / ".rehearsal" / args.run_id
    if src == out:
        raise SystemExit("--out must differ from --src")
    for f in ("aoi.json", "fields.geojson"):
        if not (src / f).exists():
            raise SystemExit(f"{src}: missing {f} (point --src at a geo hand-off, e.g. artifacts/r01)")
    summary = build(src, out, args.run_id, args.series, args.cap, not args.no_claims)
    print(f"rehearsal run written to {out}: " + ", ".join(f"{k} {v}" for k, v in summary.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
