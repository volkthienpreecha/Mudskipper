/**
 * Scripted verdict, reason, DSR, uncertain-rule, states and story cases (T6): mirrors VerdictTests,
 * SmallRuleTests, StatesTests and StoryTests in contracts/tests/test_rules.py, plus edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  awdReason,
  awdVerdict,
  confidenceFrom,
  DEFAULT_PARAMS,
  dsrSignal,
  fieldSummary,
  stageOf,
  states,
  story,
  uncertainState,
  type ObservationInput,
  type StorySummary,
} from "../src/index.ts";
import type { State, Verdict } from "../src/contracts.gen.ts";

const PARAMS = DEFAULT_PARAMS;
const STAGES = PARAMS.stage_boundaries;
const DATES = ["2026-06-23", "2026-07-05", "2026-07-17", "2026-08-10", "2026-08-22", "2026-09-03", "2026-09-15", "2026-09-27", "2026-10-09", "2026-10-21"];

describe("uncertain rule (B3.4)", () => {
  it("boundaries", () => {
    const cases: Array<[number | null, number, State]> = [
      [0.35, 0.9, "drained"],
      [0.65, 0.9, "flooded"],
      [0.3501, 0.9, "uncertain"],
      [0.6499, 0.9, "uncertain"],
      [0.99, 0.59, "uncertain"],
      [0.01, 0.6, "drained"],
      [null, 1.0, "uncertain"],
    ];
    for (const [p, valid, state] of cases) expect(uncertainState(p, valid), `${p} ${valid}`).toBe(state);
    expect(confidenceFrom(0.91)).toBe(Math.abs(2 * 0.91 - 1));
    expect(confidenceFrom(null)).toBeNull();
  });
});

describe("AWD verdict and reason (B3.5 table)", () => {
  // n, d, p_catch, k_star, verdict, reason
  const CASES: Array<[number, number, number, number | null, Verdict, string]> = [
    [6, 3, 0.97, 2, "consistent", "Drained on 3 of 6 clear looks, more than a continuously flooded field would show."],
    [6, 2, 0.97, 2, "consistent", "Drained on 2 of 6 clear looks, more than a continuously flooded field would show."],
    [6, 0, 0.97, 2, "inconsistent", "Flooded on all 6 clear looks; a field practicing AWD would have been caught drained 97% of the time."],
    [5, 0, 0.9, null, "inconsistent", "Flooded on all 5 clear looks; a field practicing AWD would have been caught drained 90% of the time."],
    [0, 0, 0.0, null, "not_enough_evidence", "No clear looks inside the AWD window."],
    [2, 0, 0.62, 2, "not_enough_evidence", "Flooded on all 2 clear looks, but these dates would catch a field practicing AWD only 62% of the time."],
    [1, 1, 0.45, null, "not_enough_evidence", "1 clear look cannot separate AWD from continuous flooding."],
    [6, 1, 0.97, 3, "not_enough_evidence", "Drained on 1 of 6 clear looks; 3 are needed to rule out a single drainage."],
    [1, 0, 0.8999, 1, "not_enough_evidence", "Flooded on the only clear look, but these dates would catch a field practicing AWD only 89% of the time."],
    [1, 0, 0.95, null, "inconsistent", "Flooded on the only clear look; a field practicing AWD would have been caught drained 95% of the time."],
    [4, 0, 0.29, 2, "not_enough_evidence", "Flooded on all 4 clear looks, but these dates would catch a field practicing AWD only 29% of the time."],
  ];

  it("scripted cases", () => {
    for (const [n, d, p, k, verdict, reason] of CASES) {
      const got = awdVerdict(n, d, p, k, 0.1);
      expect(got, `${n} ${d} ${p} ${k}`).toBe(verdict);
      expect(awdReason(got, n, d, p, k)).toBe(reason);
    }
  });

  it("the 90% bar: 1 - 0.1 is exactly 0.9", () => {
    expect(awdVerdict(3, 0, 0.9, null, 0.1)).toBe("inconsistent");
    expect(awdVerdict(3, 0, 0.8999999999999999, null, 0.1)).toBe("not_enough_evidence");
  });

  it("words follow SPEC D5", () => {
    for (const c of CASES) for (const banned of ["fraud", "cheat", "proof of"]) expect(c[5].toLowerCase()).not.toContain(banned);
  });
});

describe("DSR signal", () => {
  const f = (d: string, state: State) => ({ datetime: `${d}T13:47:34Z`, state });
  it("all four rows", () => {
    expect(dsrSignal([], 2, "2026-07-15")).toEqual({ signal: "unknown", reason: "No clear looks before 2026-07-15." });
    expect(dsrSignal([f("2026-06-23", "drained")], 2, "2026-07-15")).toEqual({ signal: "unknown", reason: "Only 1 clear look before 2026-07-15." });
    expect(dsrSignal([f("2026-06-23", "drained"), f("2026-07-05", "flooded")], 2, "2026-07-15")).toEqual({
      signal: "transplant_signal",
      reason: "Standing water on 2026-07-05, typical of puddled transplanting.",
    });
    expect(dsrSignal([f("2026-06-23", "drained"), f("2026-07-05", "drained")], 2, "2026-07-15")).toEqual({
      signal: "dsr_signal",
      reason: "Dry on all 2 clear looks before 2026-07-15, typical of direct seeding.",
    });
  });
  it("with no minimum, zero looks reads as dry on all 0 (the reference's order of checks)", () => {
    expect(dsrSignal([], 0, "2026-07-15")).toEqual({ signal: "dsr_signal", reason: "Dry on all 0 clear looks before 2026-07-15, typical of direct seeding." });
  });
});

describe("fieldSummary", () => {
  const passes = new Map(
    DATES.map((d) => {
      const id = `${d.replaceAll("-", "")}-T135D`;
      return [id, { pass_id: id, datetime: `${d}T13:47:34Z`, used: true }] as const;
    }),
  );
  const seq: State[] = ["drained", "flooded", "flooded", "drained", "flooded", "drained", "uncertain", "drained", "flooded", "drained"];
  const obs: ObservationInput[] = [...passes.values()].map((p, i) => ({ pass_id: p.pass_id, stage: stageOf(p.datetime, STAGES), inferred: { state: seq[i]! } }));

  it("window inferred from the first flooded early look; counts inside [start, end)", () => {
    const out = fieldSummary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1");
    const a = out.awd;
    expect(a.window).toEqual({ start: "2026-07-19T13:47:34Z", end: "2026-09-28T13:47:34Z", source: "inferred" });
    // inside [Jul 19, Sep 28): Aug 10 d, Aug 22 f, Sep 3 d, (Sep 15 uncertain), Sep 27 d
    expect([a.clear_looks, a.drained_hits]).toEqual([4, 3]);
    expect(out.dsr.signal).toBe("transplant_signal");
    expect(fieldSummary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1")).toEqual(out);
    expect("fixture" in out).toBe(false);
    expect(fieldSummary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1", true).fixture).toBe(true);
  });

  it("window assumed from the transplant-window midpoint", () => {
    const p = { p: { pass_id: "p", datetime: "2026-08-22T13:47:34Z", used: true } };
    const a = fieldSummary("x-00001", [{ pass_id: "p", stage: "mid", inferred: { state: "flooded" } }], p, PARAMS, STAGES, 100, 1, "t").awd;
    // midpoint of Jun 5..Jul 15 is Jun 25 00:00Z
    expect(a.window).toEqual({ start: "2026-07-09T00:00:00Z", end: "2026-09-18T00:00:00Z", source: "assumed" });
  });

  it("ignores excluded passes and uncertain states; no looks means p_catch 0 and k_star null", () => {
    const p = new Map([["x", { pass_id: "x", datetime: "2026-08-22T13:47:34Z", used: false }]]);
    const out = fieldSummary("x-00001", [{ pass_id: "x", stage: "mid", inferred: { state: "drained" } }], p, PARAMS, STAGES, 100, 1, "t");
    expect(out.awd).toMatchObject({ clear_looks: 0, drained_hits: 0, p_catch_ge1_if_awd: 0, k_star: null, verdict: "not_enough_evidence" });
    expect(out.dsr).toEqual({ signal: "unknown", reason: "No clear looks before 2026-07-15." });
    expect(() => fieldSummary("x-00001", [{ pass_id: "nope", stage: "mid", inferred: { state: "drained" } }], p, PARAMS, STAGES, 100, 1, "t")).toThrow(/unknown pass_id/);
  });

  it("the same looks and window give the same numbers on two fields (per-field seed)", () => {
    const a = fieldSummary("fazilka-00001", obs, passes, PARAMS, STAGES, 500, 1, "t1");
    const b = fieldSummary("muktsar-00009", [...obs].reverse(), passes, PARAMS, STAGES, 500, 1, "t1");
    expect(b.awd).toEqual(a.awd);
  });
});

describe("states (B3.13)", () => {
  it("grid", () => {
    const passes = [
      { pass_id: "b", datetime: "2026-07-05T00:00:00Z", used: true },
      { pass_id: "a", datetime: "2026-06-23T00:00:00Z", used: true },
      { pass_id: "x", datetime: "2026-06-24T00:00:00Z", used: false },
    ];
    const obs = [
      { field_id: "t-00002", pass_id: "a", inferred: { state: "drained" as const } },
      { field_id: "t-00001", pass_id: "b", inferred: { state: "uncertain" as const } },
      { field_id: "t-00001", pass_id: "a", inferred: { state: "flooded" as const } },
      { field_id: "t-00001", pass_id: "x", inferred: { state: "flooded" as const } }, // excluded pass: ignored
      { field_id: "zz-00001", pass_id: "a", inferred: { state: "flooded" as const } }, // unknown field: ignored
    ];
    expect(states(["t-00002", "t-00001"], passes, obs, "r")).toEqual({
      v: 1,
      run_id: "r",
      pass_ids: ["a", "b"],
      field_ids: ["t-00001", "t-00002"],
      states: ["FU", "D-"],
    });
  });

  it("ties on datetime break by pass_id", () => {
    const passes = [
      { pass_id: "p2", datetime: "2026-07-05T00:00:00Z", used: true },
      { pass_id: "p1", datetime: "2026-07-05T00:00:00Z", used: true },
    ];
    expect(states([], passes, [], "r", true).pass_ids).toEqual(["p1", "p2"]);
  });
});

describe("story (B3.11)", () => {
  const AOI = { tiles: [{ id: "a" }, { id: "b" }] };
  const summary = (verdict: Verdict, d = 0, n = 0): StorySummary => ({ awd: { verdict, drained_hits: d, clear_looks: n } });

  it("an empty tile is never the hero tile", () => {
    const fields = [
      { field_id: "b-00002", tile: "b", area_ha: 1 },
      { field_id: "b-00001", tile: "b", area_ha: 1 },
    ];
    const sums = Object.fromEntries(fields.map((f) => [f.field_id, summary("not_enough_evidence")]));
    const out = story(AOI, fields, sums, 10, "t");
    expect([out.hero_tile, out.hero_field_id]).toEqual(["b", "b-00001"]);
    expect(out.counts.pct_fields_with_enough_looks).toBe(0);
  });

  it("hero prefers consistent, then hits, looks, area, id", () => {
    const fields = [
      { field_id: "a-00001", tile: "a", area_ha: 1 },
      { field_id: "a-00002", tile: "a", area_ha: 3 },
      { field_id: "a-00003", tile: "a", area_ha: 2 },
      { field_id: "b-00001", tile: "b", area_ha: 9 },
    ];
    const sums = new Map([
      ["a-00001", summary("inconsistent", 0, 9)],
      ["a-00002", summary("consistent", 3, 6)],
      ["a-00003", summary("consistent", 3, 6)],
      ["b-00001", summary("not_enough_evidence")],
    ]);
    const out = story(AOI, fields, sums, 10, "t", true);
    expect(out.hero_field_id).toBe("a-00002"); // ties on hits and looks; larger area wins
    expect(out.headline.text).toBe("75% of 4 rice fields had enough clear radar looks for a drainage verdict.");
    expect(out.headline.tag).toBe("INFERRED");
    expect(out.counts).toEqual({ passes: 10, fields: 4, tiles: 2, pct_fields_with_enough_looks: 75 });
    expect(out.fixture).toBe(true);
  });

  it("without consistent fields, the best decided field; equal tile shares go to the first tile", () => {
    const fields = [
      { field_id: "a-00001", tile: "a", area_ha: 1 },
      { field_id: "a-00002", tile: "a", area_ha: 1 },
      { field_id: "b-00001", tile: "b", area_ha: 1 },
      { field_id: "b-00002", tile: "b", area_ha: 1 },
    ];
    const sums = {
      "a-00001": summary("not_enough_evidence", 0, 9),
      "a-00002": summary("inconsistent", 0, 4),
      "b-00001": summary("inconsistent", 0, 7),
      "b-00002": summary("not_enough_evidence"),
    };
    const out = story(AOI, fields, sums, 10, "t");
    expect([out.hero_tile, out.hero_field_id]).toEqual(["a", "a-00002"]);
  });

  it("no fields throws; a missing summary throws", () => {
    expect(() => story(AOI, [], {}, 10, "t")).toThrow(RangeError);
    expect(() => story(AOI, [{ field_id: "a-00001", tile: "a", area_ha: 1 }], {}, 10, "t")).toThrow(/no summary/);
  });
});
