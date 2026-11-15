/** Simulation (T6) and season sentence: mirrors SimulationTests and SentenceTests in contracts/tests/test_rules.py. */
import { describe, expect, it } from "vitest";
import {
  days,
  DEFAULT_PARAMS,
  detectability,
  ge,
  kStarFrom,
  mulberry32,
  sentence,
  simulate,
  stageOf,
  type Look,
  type RuleParams,
} from "../src/index.ts";

const PARAMS: RuleParams = DEFAULT_PARAMS;
const STAGES = PARAMS.stage_boundaries;
const DATES = ["2026-06-23", "2026-07-05", "2026-07-17", "2026-08-10", "2026-08-22", "2026-09-03", "2026-09-15", "2026-09-27", "2026-10-09", "2026-10-21"];
const looks = (dates: string[], hour = "13:47:34"): Look[] => dates.map((d) => [`${d}T${hour}Z`, stageOf(`${d}T${hour}Z`, STAGES)]);
const perfect = { ...PARAMS, per_pass_accuracy: { early: 1, mid: 1, late: 1 } };

describe("simulate", () => {
  it("is deterministic per seed (T6)", () => {
    const lk = looks(DATES);
    const a = simulate(lk, PARAMS, 500, 7, "awd");
    expect(simulate(lk, PARAMS, 500, 7, "awd")).toEqual(a);
    expect(simulate(lk, PARAMS, 500, 8, "awd")).not.toEqual(a);
    expect(a.reduce((s, c) => s + c, 0)).toBe(500);
    expect(a).toHaveLength(DATES.length + 1);
  });

  it("a perfect sensor never flags a never-drained CF field", () => {
    const cf = simulate(looks(DATES), { ...perfect, cf_single_drain_prob: 0 }, 300, 1, "cf");
    expect(cf[0]).toBe(300);
    expect(kStarFrom(cf, 0.1)).toBe(1);
  });

  it("daily looks always catch AWD", () => {
    const start = Date.UTC(2026, 6, 1);
    const daily = Array.from({ length: 100 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    expect(ge(simulate(looks(daily), perfect, 300, 3, "awd"), 1)).toBe(1);
  });

  it("a fixed window ignores looks outside it", () => {
    const win = ["2026-07-07T13:47:34Z", "2026-09-16T13:47:34Z"] as const;
    const a = simulate(looks(["2026-06-23", "2026-07-17", "2026-08-22", "2026-10-21"]), PARAMS, 400, 5, "awd", win);
    expect(a.slice(3)).toEqual([0, 0]);
    expect(simulate(looks(["2026-07-17", "2026-08-22"]), PARAMS, 400, 5, "awd", win).reduce((s, c) => s + c, 0)).toBe(400);
  });

  it("draws exactly 5 + |L| uniforms per run, in the order uT uC uF uP uX then one per look", () => {
    // Hand-run B3.6a with a perfect sensor: one look outside the fixed window, one inside.
    const win = ["2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z"] as const;
    const lk = looks(["2026-06-23", "2026-08-22"]);
    const nSim = 400;
    const rng = mulberry32(9);
    const [ws, we] = [days(win[0]), days(win[1])];
    const x = days(lk[1]![0]);
    const expected = [0, 0, 0];
    for (let r = 0; r < nSim; r++) {
      rng(); // uT (unused with a fixed window)
      const cyc = 4 + rng() * (10 - 4);
      const f = 0.3 + rng() * (0.5 - 0.3);
      const phi = rng() * cyc;
      rng(); // uX (CF only)
      rng(); // the look outside the window still draws
      rng(); // the look inside: u < 1 always, so label = truth
      const y = (x - ws + phi) / cyc;
      expect(ws <= x && x < we).toBe(true);
      expected[y - Math.floor(y) >= 1 - f ? 1 : 0]! += 1;
    }
    expect(simulate(lk, perfect, nSim, 9, "awd", win)).toEqual(expected);
    expect(simulate([], PARAMS, 50, 1, "cf")).toEqual([50]);
  });

  it("rejects bad scenario, n_sim and stage", () => {
    expect(() => simulate([], PARAMS, 10, 1, "xyz" as "awd")).toThrow(RangeError);
    expect(() => simulate([], PARAMS, 1.5, 1, "awd")).toThrow(RangeError);
    expect(() => simulate([["2026-06-23T00:00:00Z", "summer" as "early"]], PARAMS, 10, 1, "awd")).toThrow(RangeError);
  });
});

describe("detectability", () => {
  it("shape and sentence", () => {
    const passes = DATES.map((d) => ({ datetime: `${d}T13:47:34Z`, used: true }));
    passes.push({ datetime: "2026-07-14T00:21:29Z", used: false });
    const d = detectability(passes, PARAMS, 2000, 20261114);
    const r = d.results;
    expect(d.pass_dates).toHaveLength(10);
    expect(r.awd.p_ge1).toBeGreaterThanOrEqual(r.awd.p_ge2);
    expect(r.awd.p_ge2).toBeGreaterThanOrEqual(r.awd.p_ge3);
    expect(Math.abs(r.awd.dist.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-12);
    expect(d.sentence.startsWith("With 10 passes, ")).toBe(true);
    expect(r.k_star_rule).toBe("smallest k with cf false-flag ≤ 0.10");
  });

  it("sorts used passes by time, stably", () => {
    const d = detectability(
      [
        { datetime: "2026-08-22T13:47:34Z", used: true },
        { datetime: "2026-06-23T13:47:34Z", used: true },
        { datetime: "2026-07-01T00:00:00Z", used: false },
      ],
      PARAMS,
      100,
      1,
    );
    expect(d.pass_dates).toEqual(["2026-06-23T13:47:34Z", "2026-08-22T13:47:34Z"]);
    expect(() => detectability([], PARAMS, 0, 1)).toThrow(RangeError);
  });
});

describe("ge, kStarFrom, sentence", () => {
  it("k* = 4 still states the count", () => {
    const awd = [0, 0, 1, 1, 8];
    const cf = [4, 3, 1, 2, 0]; // P_cf(>=4) = 0 <= 0.1, P_cf(>=3) = 0.2
    const k = kStarFrom(cf, 0.1);
    expect(k).toBe(4);
    expect(sentence(4, k, awd, cf, 0.1)).toBe(
      "With 4 passes, a field practicing AWD is caught drained at least 4 times 80% of the time; a continuously flooded field shows that 0% of the time.",
    );
  });

  it("null k* and singular", () => {
    expect(kStarFrom([0, 10], 0.1)).toBeNull();
    expect(sentence(1, null, [0, 10], [0, 10], 0.1)).toBe(
      "With 1 pass, no count of drained looks separates AWD from continuous flooding at a 10% false-flag rate.",
    );
  });

  it("ge is one integer sum and one division", () => {
    expect(ge([1658, 2342], 1)).toBe(2342 / 4000);
    expect(ge([1, 2, 3], 0)).toBe(1);
    expect(ge([1, 2, 3], 5)).toBe(0);
    expect(ge([0, 0], 1)).toBe(0);
    expect(() => ge([1], -1)).toThrow(RangeError);
  });
});
