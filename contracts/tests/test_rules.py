"""Scripted cases for the normative rules (T6, T7) and cross-language vectors for the PRNG.

The PRNG and hash vectors below were produced by Node.js (V8) running the CONTRACTS.md B3.6a definitions with
Math.imul. core/'s tests use the same vectors, so Python and TypeScript are pinned to one sequence.
"""
import copy
import json
import sys
import pathlib
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import rules  # noqa: E402

NODE_MULBERRY32 = {
    0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086, 0.5450490827206522],
    1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849, 0.281103502959013],
    42: [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423, 0.5265925421845168],
    20261114: [0.12950722174718976, 0.38213343149982393, 0.757204532623291, 0.19665818405337632, 0.23901733267121017, 0.2118300348520279],
    4294967295: [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489, 0.5391399988438934],
}
NODE_FNV = {"": 2166136261, "a": 3826002220, "20261114|awd": 2843749852, "20261114|cf": 736015121, "mudskipper": 4238351173}

PARAMS = {
    "transplant_window": {"start": "2026-06-05", "end": "2026-07-15"},
    "awd_window_days_after_transplant": [14, 85], "cycle_days": [4, 10], "drained_fraction_of_cycle": [0.3, 0.5],
    "cf_single_drain_prob": 0.51, "per_pass_accuracy": {"early": 0.94, "mid": 0.8, "late": 0.8},
    "stage_boundaries": {"mid_start": "2026-07-15", "late_start": "2026-09-10"},
    "cf_false_flag_max": 0.1, "awd_miss_max": 0.1, "dsr_min_early_looks": 2,
}
STAGES = PARAMS["stage_boundaries"]
DATES = ["2026-06-23", "2026-07-05", "2026-07-17", "2026-08-10", "2026-08-22", "2026-09-03", "2026-09-15",
         "2026-09-27", "2026-10-09", "2026-10-21"]


def looks(dates, hour="13:47:34"):
    return [(f"{d}T{hour}Z", rules.stage_of(f"{d}T{hour}Z", STAGES)) for d in dates]


class PrngTests(unittest.TestCase):
    def test_mulberry32_matches_v8(self):
        for seed, expected in NODE_MULBERRY32.items():
            rng = rules.Mulberry32(seed)
            self.assertEqual([rng() for _ in expected], expected, seed)

    def test_fnv1a32_matches_v8(self):
        for text, expected in NODE_FNV.items():
            self.assertEqual(rules.fnv1a32(text), expected, text)
        self.assertEqual(rules.derive(20261114, "awd"), NODE_FNV["20261114|awd"])

    def test_days_matches_v8(self):
        self.assertEqual(rules.days("2026-06-23T13:47:34Z"), 20627.574699074074)  # Date.parse(...)/86400000
        self.assertEqual(rules.days("2026-06-05"), 20609.0)

    def test_fmt_dt_roundtrip(self):
        for dt in ("2026-06-23T13:47:34Z", "2026-12-31T23:59:59Z", "2026-01-01T00:00:00Z"):
            self.assertEqual(rules.fmt_dt(rules.parse_ms(dt)), dt)


class SmallRuleTests(unittest.TestCase):
    def test_pct_rounds_half_up(self):
        self.assertEqual([rules.pct(x) for x in (0, 0.004, 0.005, 0.125, 0.5, 0.995, 1)], [0, 0, 1, 13, 50, 100, 100])

    def test_uncertain_rule_boundaries(self):
        cases = [(0.35, 0.9, "drained"), (0.65, 0.9, "flooded"), (0.3501, 0.9, "uncertain"), (0.6499, 0.9, "uncertain"),
                 (0.99, 0.59, "uncertain"), (0.01, 0.6, "drained"), (None, 1.0, "uncertain")]
        for p, valid, state in cases:
            self.assertEqual(rules.state_from(p, valid), state, (p, valid))
        self.assertEqual(rules.confidence_from(0.91), abs(2 * 0.91 - 1))
        self.assertIsNone(rules.confidence_from(None))

    def test_stage_and_gap(self):
        self.assertEqual(rules.stage_of("2026-07-14T23:59:59Z", STAGES), "early")
        self.assertEqual(rules.stage_of("2026-07-15T00:00:00Z", STAGES), "mid")
        self.assertEqual(rules.stage_of("2026-09-10T00:00:00Z", STAGES), "late")
        gap = [{"start": "2026-07-27T22:03:25Z", "end": "2026-08-10T00:55:27Z"}]
        self.assertTrue(rules.in_gap("2026-07-27T22:03:25Z", gap))   # closed interval
        self.assertTrue(rules.in_gap("2026-08-10T00:55:27Z", gap))
        self.assertFalse(rules.in_gap("2026-08-10T13:47:34Z", gap))  # real descending pass just after the gap


class SentenceTests(unittest.TestCase):
    def test_k_star_four_still_states_the_count(self):
        awd, cf = [0, 0, 1, 1, 8], [4, 3, 1, 2, 0]   # P_cf(>=4) = 0 <= 0.1, P_cf(>=3) = 0.2
        k = rules.k_star_from(cf, 0.1)
        self.assertEqual(k, 4)
        self.assertEqual(rules.sentence(4, k, awd, cf, 0.1),
                         "With 4 passes, a field practicing AWD is caught drained at least 4 times 80% of the time; "
                         "a continuously flooded field shows that 0% of the time.")

    def test_null_k_star_and_singular(self):
        self.assertIsNone(rules.k_star_from([0, 10], 0.1))
        self.assertEqual(rules.sentence(1, None, [0, 10], [0, 10], 0.1),
                         "With 1 pass, no count of drained looks separates AWD from continuous flooding at a 10% "
                         "false-flag rate.")

    def test_ge_is_one_sum_one_division(self):
        counts = [1658, 2342]
        self.assertEqual(rules.ge(counts, 1), 2342 / 4000)


class StoryTests(unittest.TestCase):
    AOI = {"tiles": [{"id": "a"}, {"id": "b"}]}

    def summary(self, verdict, d=0, n=0):
        return {"awd": {"verdict": verdict, "drained_hits": d, "clear_looks": n}}

    def test_empty_tile_is_never_hero(self):
        fields = [{"field_id": "b-00002", "tile": "b", "area_ha": 1}, {"field_id": "b-00001", "tile": "b", "area_ha": 1}]
        sums = {f["field_id"]: self.summary("not_enough_evidence") for f in fields}
        out = rules.story(self.AOI, fields, sums, 10, "t")
        self.assertEqual((out["hero_tile"], out["hero_field_id"]), ("b", "b-00001"))
        self.assertEqual(out["counts"]["pct_fields_with_enough_looks"], 0)

    def test_hero_prefers_consistent_then_hits_looks_area_id(self):
        fields = [{"field_id": "a-00001", "tile": "a", "area_ha": 1}, {"field_id": "a-00002", "tile": "a", "area_ha": 3},
                  {"field_id": "a-00003", "tile": "a", "area_ha": 2}, {"field_id": "b-00001", "tile": "b", "area_ha": 9}]
        sums = {"a-00001": self.summary("inconsistent", 0, 9), "a-00002": self.summary("consistent", 3, 6),
                "a-00003": self.summary("consistent", 3, 6), "b-00001": self.summary("not_enough_evidence")}
        out = rules.story(self.AOI, fields, sums, 10, "t", fixture=True)
        self.assertEqual(out["hero_field_id"], "a-00002")  # ties on hits and looks; larger area wins
        self.assertEqual(out["headline"]["text"], "75% of 4 rice fields had enough clear radar looks for a drainage verdict.")
        self.assertEqual(out["counts"], {"passes": 10, "fields": 4, "tiles": 2, "pct_fields_with_enough_looks": 75})

    def test_no_fields_raises(self):
        with self.assertRaises(ValueError):
            rules.story(self.AOI, [], {}, 10, "t")


class GeometryTests(unittest.TestCase):
    L_SHAPE = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]]}

    def test_concave_claim_point_is_inside(self):
        x, y = rules.representative_point(self.L_SHAPE)
        self.assertTrue(rules.contains(self.L_SHAPE, x, y), (x, y))

    def test_convex_claim_uses_vertex_average(self):
        sq = {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]}
        self.assertEqual(rules.representative_point(sq), (1.0, 1.0))

    def test_open_ring_rejected(self):
        with self.assertRaises(rules.GeometryError):
            rules.representative_point({"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2]]]})

    def test_shared_edge_belongs_to_one_cell(self):
        left = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        right = {"type": "Polygon", "coordinates": [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]}
        self.assertEqual(rules.contains(left, 1.0, 0.5) + rules.contains(right, 1.0, 0.5), 1)


class SimulationTests(unittest.TestCase):
    def test_deterministic_per_seed(self):  # T6
        lk = looks(DATES)
        a = rules.simulate(lk, PARAMS, 500, 7, "awd")
        self.assertEqual(a, rules.simulate(lk, PARAMS, 500, 7, "awd"))
        self.assertNotEqual(a, rules.simulate(lk, PARAMS, 500, 8, "awd"))
        self.assertEqual(sum(a), 500)
        self.assertEqual(len(a), len(DATES) + 1)

    def test_perfect_sensor_never_flags_cf_without_drains(self):
        p = copy.deepcopy(PARAMS)
        p["per_pass_accuracy"] = {"early": 1, "mid": 1, "late": 1}
        p["cf_single_drain_prob"] = 0
        cf = rules.simulate(looks(DATES), p, 300, 1, "cf")
        self.assertEqual(cf[0], 300)
        self.assertEqual(rules.k_star_from(cf, 0.1), 1)

    def test_daily_looks_always_catch_awd(self):
        import datetime as _dt
        start = _dt.date(2026, 7, 1)
        daily = [(start + _dt.timedelta(days=i)).isoformat() for i in range(100)]
        p = copy.deepcopy(PARAMS)
        p["per_pass_accuracy"] = {"early": 1, "mid": 1, "late": 1}
        awd = rules.simulate(looks(daily), p, 300, 3, "awd")
        self.assertEqual(rules.ge(awd, 1), 1.0)

    def test_fixed_window_ignores_looks_outside(self):
        win = ("2026-07-07T13:47:34Z", "2026-09-16T13:47:34Z")
        inside = looks(["2026-07-17", "2026-08-22"])
        with_outside = looks(["2026-06-23", "2026-07-17", "2026-08-22", "2026-10-21"])
        a = rules.simulate(with_outside, PARAMS, 400, 5, "awd", win)
        self.assertEqual(a[3:], [0, 0])  # at most two looks fall in the window
        self.assertEqual(sum(rules.simulate(inside, PARAMS, 400, 5, "awd", win)), 400)

    def test_detectability_shape_and_sentence(self):
        passes = [{"datetime": f"{d}T13:47:34Z", "used": True} for d in DATES]
        passes.append({"datetime": "2026-07-14T00:21:29Z", "used": False})
        d = rules.detectability(passes, PARAMS, 2000, 20261114)
        r = d["results"]
        self.assertEqual(len(d["pass_dates"]), 10)
        self.assertGreaterEqual(r["awd"]["p_ge1"], r["awd"]["p_ge2"])
        self.assertGreaterEqual(r["awd"]["p_ge2"], r["awd"]["p_ge3"])
        self.assertAlmostEqual(sum(r["awd"]["dist"]), 1.0, places=12)
        self.assertTrue(d["sentence"].startswith("With 10 passes, "))
        self.assertEqual(r["k_star_rule"], "smallest k with cf false-flag ≤ 0.10")


class VerdictTests(unittest.TestCase):
    """T6: scripted verdict cases, one per row of the CONTRACTS.md B3.5 table."""

    CASES = [
        # n, d, p_catch, k_star, verdict, reason
        (6, 3, 0.97, 2, "consistent", "Drained on 3 of 6 clear looks, more than a continuously flooded field would show."),
        (6, 2, 0.97, 2, "consistent", "Drained on 2 of 6 clear looks, more than a continuously flooded field would show."),
        (6, 0, 0.97, 2, "inconsistent", "Flooded on all 6 clear looks; a field practicing AWD would have been caught drained 97% of the time."),
        (5, 0, 0.90, None, "inconsistent", "Flooded on all 5 clear looks; a field practicing AWD would have been caught drained 90% of the time."),
        (0, 0, 0.0, None, "not_enough_evidence", "No clear looks inside the AWD window."),
        (2, 0, 0.62, 2, "not_enough_evidence", "Flooded on all 2 clear looks, but these dates would catch a field practicing AWD only 62% of the time."),
        (1, 1, 0.45, None, "not_enough_evidence", "1 clear look cannot separate AWD from continuous flooding."),
        (6, 1, 0.97, 3, "not_enough_evidence", "Drained on 1 of 6 clear looks; 3 are needed to rule out a single drainage."),
        (1, 0, 0.8999, 1, "not_enough_evidence", "Flooded on the only clear look, but these dates would catch a field practicing AWD only 89% of the time."),
        (1, 0, 0.95, None, "inconsistent", "Flooded on the only clear look; a field practicing AWD would have been caught drained 95% of the time."),
        (4, 0, 0.29, 2, "not_enough_evidence", "Flooded on all 4 clear looks, but these dates would catch a field practicing AWD only 29% of the time."),
    ]

    def test_scripted_cases(self):
        for n, d, p, k, verdict, reason in self.CASES:
            with self.subTest(n=n, d=d, p=p, k=k):
                got = rules.awd_verdict(n, d, p, k, 0.1)
                self.assertEqual(got, verdict)
                self.assertEqual(rules.awd_reason(got, n, d, p, k), reason)

    def test_words_follow_d5(self):
        for *_, reason in self.CASES:
            for banned in ("fraud", "cheat", "proof of"):
                self.assertNotIn(banned, reason.lower())

    def test_dsr_signal(self):
        f = lambda d, s: (rules.parse_ms(f"{d}T13:47:34Z"), f"{d}T13:47:34Z", "early", s)
        self.assertEqual(rules.dsr_signal([], 2, "2026-07-15"), ("unknown", "No clear looks before 2026-07-15."))
        self.assertEqual(rules.dsr_signal([f("2026-06-23", "drained")], 2, "2026-07-15"),
                         ("unknown", "Only 1 clear look before 2026-07-15."))
        self.assertEqual(rules.dsr_signal([f("2026-06-23", "drained"), f("2026-07-05", "flooded")], 2, "2026-07-15"),
                         ("transplant_signal", "Standing water on 2026-07-05, typical of puddled transplanting."))
        self.assertEqual(rules.dsr_signal([f("2026-06-23", "drained"), f("2026-07-05", "drained")], 2, "2026-07-15"),
                         ("dsr_signal", "Dry on all 2 clear looks before 2026-07-15, typical of direct seeding."))

    def test_field_summary_window_inferred_and_counts(self):
        passes = {f"{d.replace('-', '')}-T135D": {"pass_id": f"{d.replace('-', '')}-T135D", "datetime": f"{d}T13:47:34Z",
                                                  "used": True} for d in DATES}
        states = ["drained", "flooded", "flooded", "drained", "flooded", "drained", "uncertain", "drained", "flooded", "drained"]
        obs = [{"pass_id": pid, "stage": rules.stage_of(p["datetime"], STAGES), "inferred": {"state": s}}
               for (pid, p), s in zip(passes.items(), states)]
        out = rules.field_summary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1")
        a = out["awd"]
        self.assertEqual(a["window"], {"start": "2026-07-19T13:47:34Z", "end": "2026-09-28T13:47:34Z", "source": "inferred"})
        # inside [Jul 19, Sep 28): Aug 10 d, Aug 22 f, Sep 3 d, (Sep 15 uncertain), Sep 27 d
        self.assertEqual((a["clear_looks"], a["drained_hits"]), (4, 3))
        self.assertEqual(out["dsr"]["signal"], "transplant_signal")
        again = rules.field_summary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1")
        self.assertEqual(out, again)

    def test_field_summary_window_assumed(self):
        passes = {"p": {"pass_id": "p", "datetime": "2026-08-22T13:47:34Z", "used": True}}
        obs = [{"pass_id": "p", "stage": "mid", "inferred": {"state": "flooded"}}]
        a = rules.field_summary("x-00001", obs, passes, PARAMS, STAGES, 100, 1, "t")["awd"]
        # midpoint of Jun 5..Jul 15 is Jun 25 00:00Z
        self.assertEqual(a["window"], {"start": "2026-07-09T00:00:00Z", "end": "2026-09-18T00:00:00Z", "source": "assumed"})


def _square(lon, lat, d=0.001):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}


def _world(n_per_district=20):
    fields, summaries = [], {}
    verdicts = ["inconsistent", "not_enough_evidence", "consistent"]
    signals = ["transplant_signal", "unknown", "dsr_signal"]
    for di, district in enumerate(("Fazilka", "Sri Muktsar Sahib")):
        tile = ("fazilka", "muktsar")[di]
        for i in range(n_per_district):
            fid = f"{tile}-{i + 1:05d}"
            lon, lat = 74.0 + di + i * 0.01, 30.0
            fields.append({"type": "Feature", "geometry": _square(lon, lat),
                           "properties": {"field_id": fid, "tile": tile, "district": district, "area_ha": 1 + (i % 4),
                                          "lon": lon + 0.0005, "lat": lat + 0.0005}})
            summaries[fid] = {"awd": {"verdict": verdicts[i % 3], "clear_looks": 5, "drained_hits": i % 3},
                              "dsr": {"signal": signals[(i + 1) % 3]}}
    return fields, summaries


def _body(fields, budget, seed=None, extra=None, claimed=("awd",)):
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [f["properties"]["lon"], f["properties"]["lat"]]},
              "properties": {"claim_id": f"C{i:03d}", "claimed": list(claimed), "synthetic": True}}
             for i, f in enumerate(fields)]
    feats += extra or []
    req = {"claims": {"type": "FeatureCollection", "features": feats}, "budget": budget}
    if seed is not None:
        req["seed"] = seed
    return json.dumps(req).encode()


class RankTests(unittest.TestCase):
    """T7: exactly 20% random picks; same output for the same seed."""

    def setUp(self):
        self.fields, self.summaries = _world()

    def rank(self, body):
        return rules.rank(body, self.fields, self.summaries, "t1", "2026-11-14T00:00:00Z", False)

    def test_twenty_percent_random(self):
        for budget in (5, 10, 15, 20, 25, 40):
            out = self.rank(_body(self.fields, budget, seed=1))
            picks = [r["pick"] for r in out["ranked"]]
            self.assertEqual(len(picks), budget)
            self.assertEqual(picks.count("random") * 5, budget, budget)
            self.assertEqual(picks, ["score"] * (budget - budget // 5) + ["random"] * (budget // 5))
            self.assertEqual([r["rank"] for r in out["ranked"]], list(range(1, budget + 1)))

    def test_same_seed_same_output_and_seed_matters(self):
        a = self.rank(_body(self.fields, 20, seed=11))
        self.assertEqual(a, self.rank(_body(self.fields, 20, seed=11)))
        randoms = {tuple(r["claim_id"] for r in self.rank(_body(self.fields, 20, seed=s))["ranked"] if r["pick"] == "random")
                   for s in range(8)}
        self.assertGreater(len(randoms), 1)

    def test_missing_seed_comes_from_input_hash(self):
        body = _body(self.fields, 10)
        out = self.rank(body)
        import hashlib
        self.assertEqual(out["seed"], int(hashlib.sha256(body).hexdigest()[:8], 16))
        self.assertEqual(out, self.rank(body))

    def test_score_order_and_weights(self):
        out = self.rank(_body(self.fields, 40, seed=3))
        score = [r for r in out["ranked"] if r["pick"] == "score"]
        self.assertEqual([r["score"] for r in score], sorted((r["score"] for r in score), reverse=True))
        top = score[0]
        self.assertEqual(top["weight"], 1.0)
        self.assertTrue(top["reason"].startswith("Not consistent with AWD ("))
        self.assertEqual(out["notice"], "Ranking for inspection, not a finding about anyone.")

    def test_stratified_by_district(self):
        for seed in range(5):
            out = self.rank(_body(self.fields, 20, seed=seed))  # 16 by score, 4 random from the other 24
            picked = {r["claim_id"] for r in out["ranked"] if r["pick"] == "score"}
            remaining = [f for i, f in enumerate(self.fields) if f"C{i:03d}" not in picked]
            randoms = [r["district"] for r in out["ranked"] if r["pick"] == "random"]
            for district in ("Fazilka", "Sri Muktsar Sahib"):
                share = sum(1 for f in remaining if f["properties"]["district"] == district) / len(remaining)
                self.assertLessEqual(abs(randoms.count(district) - 4 * share), 1, (seed, district))

    def test_unmatched_merged_and_dsr(self):
        extra = [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [10.0, 10.0]},
             "properties": {"claim_id": "U1", "claimed": ["awd"], "synthetic": True, "area_ha": 2.5}},
            {"type": "Feature", "geometry": self.fields[0]["geometry"],
             "properties": {"claim_id": "DUP", "claimed": ["dsr"], "synthetic": False}},
        ]
        out = self.rank(_body(self.fields[:4], 10, seed=2, extra=extra))
        self.assertEqual((out["matched"], out["unmatched"]), (5, 1))
        self.assertFalse(out["synthetic"])
        by_claim = {r["claim_id"]: r for r in out["ranked"]}
        self.assertEqual(by_claim["U1"]["field_id"], None)
        self.assertEqual(by_claim["U1"]["score"], 0.8 * 2.5)
        merged = by_claim["C000"]  # field 1 claimed for awd (C000) and dsr (DUP): one candidate, max weight
        self.assertIn("; DSR", merged["reason"])
        self.assertNotIn("DUP", by_claim)
        self.assertEqual(len(out["ranked"]), 5)  # 4 fields + 1 unmatched; budget larger than candidates

    def test_concave_field_claim_matches(self):
        field = {"type": "Feature", "geometry": GeometryTests.L_SHAPE,
                 "properties": {"field_id": "fazilka-00001", "tile": "fazilka", "district": "Fazilka", "area_ha": 2}}
        claim = [{"type": "Feature", "geometry": GeometryTests.L_SHAPE,
                  "properties": {"claim_id": "L", "claimed": ["awd"], "synthetic": True}}]
        out = rules.rank(_body([], 5, seed=1, extra=claim), [field], {}, "t", "2026-11-14T00:00:00Z", False)
        self.assertEqual((out["matched"], out["ranked"][0]["field_id"]), (1, "fazilka-00001"))
        self.assertEqual(out["ranked"][0]["reason"], "No season summary yet")

    def test_duplicate_claim_id_rejected_and_missing_id_assigned(self):
        dup = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [10.0, 10.0]},
                "properties": {"claim_id": "X", "claimed": ["awd"], "synthetic": True}}] * 2
        with self.assertRaises(rules.RankError) as ctx:
            self.rank(_body([], 5, seed=1, extra=dup))
        self.assertEqual(ctx.exception.code, "duplicate_claim_id")
        anon = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [10.0, 10.0]},
                 "properties": {"claimed": ["awd"], "synthetic": True}}] * 2
        out = self.rank(_body([], 5, seed=1, extra=anon))
        self.assertEqual(sorted(r["claim_id"] for r in out["ranked"]), ["#1", "#2"])

    def test_open_ring_claim_rejected(self):
        bad = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]]},
                "properties": {"claimed": ["awd"], "synthetic": True}}]
        with self.assertRaises(rules.RankError) as ctx:
            self.rank(_body([], 5, seed=1, extra=bad))
        self.assertEqual(ctx.exception.code, "invalid_geometry")

    def test_seed_zero_is_a_seed(self):
        body = _body(self.fields, 10, seed=0)
        self.assertEqual(self.rank(body)["seed"], 0)

    def test_field_id_hint_wins_over_geometry(self):
        hint = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [10.0, 10.0]},
                 "properties": {"claim_id": "H", "claimed": ["awd"], "synthetic": True, "field_id": "muktsar-00003"}}]
        out = self.rank(_body([], 5, seed=1, extra=hint))
        self.assertEqual(out["ranked"][0]["field_id"], "muktsar-00003")


if __name__ == "__main__":
    unittest.main()
