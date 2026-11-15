#!/usr/bin/env python3
"""Differential test, Python side: random cases through contracts/rules.py (the reference).

    python3 core/scripts/differential.py OUT.json [--seed N] [--cases N]
    node core/scripts/differential.ts OUT.json        # core must agree on every case, exactly

The golden tests pin core to the committed fixtures; this goes further and draws random parameters, look
dates, states, seeds, claim geometries (points, field polygons, concave polygons, multipolygons, points
outside every field), field_id hints, budgets and request byte layouts, so drift in any branch of the rules
shows up. Standard library only; deterministic for a given --seed.
"""
import argparse
import json
import pathlib
import random
import sys

CONTRACTS = pathlib.Path(__file__).resolve().parents[2] / "contracts"
sys.path.insert(0, str(CONTRACTS))
import rules  # noqa: E402

RUN = CONTRACTS / "fixtures" / "run"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--cases", type=int, default=150)
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    det = json.loads((RUN / "detectability.json").read_text(encoding="utf-8"))
    fields = json.loads((RUN / "fields.geojson").read_text(encoding="utf-8"))["features"]
    summaries = {}
    for line in (RUN / "field_summary.jsonl").read_text(encoding="utf-8").splitlines():
        s = json.loads(line)
        summaries[s["field_id"]] = s
    params0 = det["params"]
    stages = params0["stage_boundaries"]
    season0 = rules.parse_ms("2026-06-17")

    def rand_params():
        p = json.loads(json.dumps(params0))
        a0 = rnd.randint(0, 30)
        p["awd_window_days_after_transplant"] = [a0, a0 + rnd.randint(10, 100)]
        c0 = rnd.uniform(1, 8)
        p["cycle_days"] = [c0, c0 + rnd.uniform(0, 10)]
        f0 = rnd.uniform(0, 0.6)
        p["drained_fraction_of_cycle"] = [f0, min(1, f0 + rnd.uniform(0, 0.4))]
        p["cf_single_drain_prob"] = rnd.random()
        p["per_pass_accuracy"] = {k: rnd.uniform(0.5, 1) for k in ("early", "mid", "late")}
        p["dsr_min_early_looks"] = rnd.randint(1, 4)
        return p

    sim_cases = []
    for i in range(args.cases):
        p = rand_params() if i % 2 else params0
        dts = sorted(rules.fmt_dt(season0 + rnd.randint(0, 130 * 86400) * 1000) for _ in range(rnd.randint(0, 14)))
        passes = {f"p{j}": {"pass_id": f"p{j}", "datetime": dt, "used": rnd.random() < 0.9} for j, dt in enumerate(dts)}
        obs = [{"pass_id": pid, "stage": rules.stage_of(pp["datetime"], stages),
                "inferred": {"state": rnd.choice(["flooded", "drained", "uncertain"])}} for pid, pp in passes.items()]
        rnd.shuffle(obs)
        seed = rnd.randint(0, 2**32 - 1)
        n_sim = rnd.choice([100, 400, 1000])
        looks = [(pp["datetime"], rules.stage_of(pp["datetime"], stages)) for pp in sorted(passes.values(), key=lambda x: x["datetime"])]
        scenario = rnd.choice(["awd", "cf"])
        window = None
        if rnd.random() < 0.5:
            window = (rules.fmt_dt(season0 + rnd.randint(0, 60) * 86400000), rules.fmt_dt(season0 + rnd.randint(61, 130) * 86400000))
        sim_cases.append({
            "params": p, "passes": passes, "obs": obs, "seed": seed, "n_sim": n_sim, "looks": looks,
            "scenario": scenario, "window": window,
            "summary": rules.field_summary("fazilka-00001", obs, passes, p, stages, n_sim, seed, "dt"),
            "counts": rules.simulate(looks, p, n_sim, seed, scenario, window),
            "detectability": rules.detectability(list(passes.values()), p, n_sim, seed),
        })

    def near(f):
        pr = f["properties"]
        return [pr["lon"] + rnd.uniform(-0.003, 0.003), pr["lat"] + rnd.uniform(-0.003, 0.003)]

    rank_cases = []
    for _ in range(args.cases):
        feats = []
        for k in range(rnd.randint(1, 120)):
            f = rnd.choice(fields)
            r = rnd.random()
            if r < 0.4:
                pt = near(f) if rnd.random() < 0.5 else [f["properties"]["lon"], f["properties"]["lat"]]
                geom = {"type": "Point", "coordinates": pt}
            elif r < 0.6:
                geom = f["geometry"]
            elif r < 0.75:  # an L-shaped (concave) claim
                c, d = near(f), rnd.uniform(0.0002, 0.003)
                ring = [[c[0], c[1]], [c[0] + d, c[1]], [c[0] + d, c[1] + d / 3], [c[0] + d / 3, c[1] + d / 3],
                        [c[0] + d / 3, c[1] + d], [c[0], c[1] + d], [c[0], c[1]]]
                geom = {"type": "Polygon", "coordinates": [ring]}
            elif r < 0.85:
                geom = {"type": "MultiPolygon", "coordinates": [f["geometry"]["coordinates"], rnd.choice(fields)["geometry"]["coordinates"]]}
            else:  # most of these fall outside every field
                geom = {"type": "Point", "coordinates": [rnd.uniform(73.9, 74.7), rnd.uniform(30.1, 30.6)]}
            props = {"claimed": rnd.choice([["awd"], ["dsr"], ["awd", "dsr"], ["dsr", "awd"]]), "synthetic": rnd.random() < 0.9}
            if rnd.random() < 0.8:
                props["claim_id"] = f"K{k}"
            if rnd.random() < 0.2:
                props["field_id"] = rnd.choice(fields)["properties"]["field_id"] if rnd.random() < 0.8 else "fazilka-99999"
            if rnd.random() < 0.3:
                props["area_ha"] = round(rnd.uniform(0, 5), 3)
            feats.append({"type": "Feature", "geometry": geom, "properties": props})
        if rnd.random() < 0.04:  # a duplicate claim_id
            feats.append({**feats[0], "properties": {**feats[0]["properties"], "claim_id": "DUP"}})
            feats.append({**feats[0], "properties": {**feats[0]["properties"], "claim_id": "DUP"}})
        if rnd.random() < 0.04:  # an open ring
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[74, 30], [74.1, 30], [74.1, 30.1], [74, 30.1]]]},
                          "properties": {"claimed": ["awd"], "synthetic": True}})
        req = {"claims": {"type": "FeatureCollection", "features": feats}, "budget": rnd.randint(1, 500)}
        if rnd.random() < 0.7:
            req["seed"] = rnd.randint(0, 2**32 - 1)
        body = json.dumps(req, separators=(",", ":") if rnd.random() < 0.5 else (", ", ": "))
        sums = summaries if rnd.random() < 0.85 else {k: v for k, v in summaries.items() if rnd.random() < 0.5}
        try:
            expected, error = rules.rank(body.encode("utf-8"), fields, sums, "fixture", "2026-11-14T00:00:00Z", True), None
        except rules.RankError as exc:
            expected, error = None, exc.code
        rank_cases.append({"body": body, "summary_ids": sorted(sums), "expected": expected, "error": error})

    pathlib.Path(args.out).write_text(json.dumps({"sim": sim_cases, "rank": rank_cases}, allow_nan=False), encoding="utf-8")
    errors = sum(1 for c in rank_cases if c["error"])
    print(f"differential.py: {len(sim_cases)} rule cases, {len(rank_cases)} ranking cases ({errors} rejected) -> {args.out}")


if __name__ == "__main__":
    main()
