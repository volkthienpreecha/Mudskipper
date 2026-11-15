/**
 * The detectability simulation (CONTRACTS.md B3.6, B3.6a). Python reference: `rules.simulate`, `rules.ge`,
 * `rules.k_star_from`, `rules.detectability`, `rules.sentence`.
 *
 * Every operation below is plain IEEE-754 double arithmetic in exactly the order the contract writes it,
 * so Python and TypeScript produce the same counts bit for bit. Do not "simplify" an expression here: even
 * reassociating `x - ws + phi` would change results in the last bit and break the golden tests.
 */
import type { DetectabilityResults, Stage } from "./contracts.gen.ts";
import { pct, passesText, timesText } from "./format.ts";
import { derive, mulberry32 } from "./prng.ts";
import { days, parseMs, stageOf, type StageBoundaries } from "./time.ts";

export const K_STAR_RULE = "smallest k with cf false-flag ≤ 0.10";

/** What the simulation reads from `detectability.params`. Generated `Params` objects are assignable. */
export interface SimParams {
  readonly transplant_window: { readonly start: string; readonly end: string };
  readonly awd_window_days_after_transplant: readonly [number, number];
  readonly cycle_days: readonly [number, number];
  readonly drained_fraction_of_cycle: readonly [number, number];
  readonly cf_single_drain_prob: number;
  readonly per_pass_accuracy: { readonly [S in Stage]: number };
}

/** All of `detectability.params` that the rules read (simulation, verdicts, DSR signal). */
export interface RuleParams extends SimParams {
  readonly stage_boundaries: StageBoundaries;
  readonly cf_false_flag_max: number;
  readonly awd_miss_max: number;
  readonly dsr_min_early_looks: number;
}

/** One look: its datetime string and its stage. Looks must be sorted ascending by time. */
export type Look = readonly [datetime: string, stage: Stage];
export type Scenario = "awd" | "cf";

function checkCount(name: string, n: number, min: number): void {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${name} must be an integer ≥ ${min}, got ${n}`);
}

/**
 * B3.6a. Returns `counts` of length `looks.length + 1`: counts[k] = runs with exactly k drained labels.
 * Every run draws exactly `5 + looks.length` uniforms. With `window`, the AWD window is fixed to
 * `[window[0], window[1])` instead of being drawn from the transplant window.
 */
export function simulate(
  looks: ReadonlyArray<Look>,
  params: SimParams,
  nSim: number,
  seed: number,
  scenario: Scenario,
  window?: readonly [start: string, end: string],
): number[] {
  if (scenario !== "awd" && scenario !== "cf") throw new RangeError(`unknown scenario ${String(scenario)}`);
  checkCount("nSim", nSim, 0);
  const rng = mulberry32(seed);
  const n = looks.length;
  const xs = new Array<number>(n);
  const accs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const [dt, stage] = looks[i]!;
    xs[i] = days(dt);
    const acc = params.per_pass_accuracy[stage];
    if (typeof acc !== "number") throw new RangeError(`no per_pass_accuracy for stage ${String(stage)}`);
    accs[i] = acc;
  }
  const [a0, a1] = params.awd_window_days_after_transplant;
  const [c0, c1] = params.cycle_days;
  const [f0, f1] = params.drained_fraction_of_cycle;
  const tw0 = days(params.transplant_window.start);
  const tw1 = days(params.transplant_window.end);
  const q = params.cf_single_drain_prob;
  const fixed = window === undefined ? null : ([days(window[0]), days(window[1])] as const);
  const isAwd = scenario === "awd";
  const counts = new Array<number>(n + 1).fill(0);

  for (let run = 0; run < nSim; run++) {
    const uT = rng();
    const uC = rng();
    const uF = rng();
    const uP = rng();
    const uX = rng();
    let ws: number;
    let we: number;
    if (fixed === null) {
      const t0 = tw0 + uT * (tw1 - tw0);
      ws = t0 + a0;
      we = t0 + a1;
    } else {
      ws = fixed[0];
      we = fixed[1];
    }
    const cyc = c0 + uC * (c1 - c0);
    const fracDrained = f0 + uF * (f1 - f0);
    let phi = 0;
    let threshold = 0;
    let start = 0;
    let dur = 0;
    let single = false;
    if (isAwd) {
      phi = uP * cyc;
      threshold = 1 - fracDrained;
    } else {
      dur = fracDrained * cyc;
      start = ws + uP * (we - ws - dur);
      single = uX < q;
    }
    let k = 0;
    for (let i = 0; i < n; i++) {
      const u = rng(); // drawn for every look, inside the window or not
      const x = xs[i]!;
      if (ws <= x && x < we) {
        let truth: boolean;
        if (isAwd) {
          const y = (x - ws + phi) / cyc;
          truth = y - Math.floor(y) >= threshold;
        } else {
          truth = single && start <= x && x < start + dur;
        }
        const label = u < accs[i]! ? truth : !truth;
        if (label) k += 1;
      }
    }
    counts[k]! += 1;
  }
  return counts;
}

/** P(at least k drained labels) = (Σ_{j ≥ k} counts[j]) / Σ counts: one integer sum, one division. */
export function ge(counts: ReadonlyArray<number>, k: number): number {
  checkCount("k", k, 0);
  let total = 0;
  let tail = 0;
  for (let j = 0; j < counts.length; j++) {
    total += counts[j]!;
    if (j >= k) tail += counts[j]!;
  }
  return total ? tail / total : 0;
}

/** Smallest k in 1…|L| with P(≥ k | CF) ≤ `cfFalseFlagMax`, else null. */
export function kStarFrom(cfCounts: ReadonlyArray<number>, cfFalseFlagMax: number): number | null {
  for (let k = 1; k < cfCounts.length; k++) {
    if (ge(cfCounts, k) <= cfFalseFlagMax) return k;
  }
  return null;
}

/** The season sentence of B3.6 (exact text). */
export function sentence(
  n: number,
  kStar: number | null,
  awdCounts: ReadonlyArray<number>,
  cfCounts: ReadonlyArray<number>,
  cfFalseFlagMax: number,
): string {
  if (kStar !== null) {
    return (
      `With ${passesText(n)}, a field practicing AWD is caught drained at least ${timesText(kStar)} ` +
      `${pct(ge(awdCounts, kStar))}% of the time; a continuously flooded field shows that ` +
      `${pct(ge(cfCounts, kStar))}% of the time.`
    );
  }
  return (
    `With ${passesText(n)}, no count of drained looks separates AWD from continuous flooding at a ` +
    `${pct(cfFalseFlagMax)}% false-flag rate.`
  );
}

/** A pass as the season simulation reads it (`passes.json` entries are assignable). */
export interface PassTime {
  readonly datetime: string;
  readonly used: boolean;
}

export interface DetectabilityCore {
  pass_dates: string[];
  results: DetectabilityResults;
  sentence: string;
}

/**
 * Season-level results (B3.6): every used pass is a clear look, sorted by time (stable, so equal times keep
 * input order). AWD uses `derive(seed, "awd")`, CF uses `derive(seed, "cf")`.
 */
export function detectability(
  passes: ReadonlyArray<PassTime>,
  params: RuleParams,
  nSim: number,
  seed: number,
): DetectabilityCore {
  checkCount("nSim", nSim, 1);
  const used = passes
    .filter((p) => p.used)
    .map((p) => ({ p, ms: parseMs(p.datetime) }))
    .sort((a, b) => a.ms - b.ms)
    .map((e) => e.p);
  const looks: Look[] = used.map((p) => [p.datetime, stageOf(p.datetime, params.stage_boundaries)]);
  const awd = simulate(looks, params, nSim, derive(seed, "awd"), "awd");
  const cf = simulate(looks, params, nSim, derive(seed, "cf"), "cf");
  const kStar = kStarFrom(cf, params.cf_false_flag_max);
  const results: DetectabilityResults = {
    awd: {
      p_ge1: ge(awd, 1),
      p_ge2: ge(awd, 2),
      p_ge3: ge(awd, 3),
      dist: awd.map((c) => c / nSim) as DetectabilityResults["awd"]["dist"],
    },
    cf: {
      p_ge1_false: ge(cf, 1),
      p_ge2_false: ge(cf, 2),
      dist: cf.map((c) => c / nSim) as DetectabilityResults["cf"]["dist"],
    },
    k_star: kStar,
    k_star_rule: K_STAR_RULE,
  };
  return {
    pass_dates: used.map((p) => p.datetime),
    results,
    sentence: sentence(looks.length, kStar, awd, cf, params.cf_false_flag_max),
  };
}
