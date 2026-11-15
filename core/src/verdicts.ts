/**
 * Per-field rules: the uncertain rule (B3.4), the AWD verdict and its reason, the DSR signal and the full
 * `field_summary.jsonl` line (B3.5). Python reference: `rules.state_from`, `rules.confidence_from`,
 * `rules.awd_verdict`, `rules.awd_reason`, `rules.dsr_signal`, `rules.field_summary`.
 */
import type { DsrSignal, FieldSummaryLine, Stage, State, Verdict } from "./contracts.gen.ts";
import { allLooksText, looksText, pctDown } from "./format.ts";
import { derive } from "./prng.ts";
import { ge, kStarFrom, simulate, type Look, type PassTime, type RuleParams } from "./sim.ts";
import { DAY_MS, fmtDt, parseMs, type StageBoundaries } from "./time.ts";

// Uncertain rule thresholds (B3.4).
export const VALID_FRAC_MIN = 0.6;
export const P_DRAINED_MAX = 0.35;
export const P_FLOODED_MIN = 0.65;

/**
 * B3.4: `uncertain` if valid_frac < 0.6, p_flooded is null, or 0.35 < p_flooded < 0.65; otherwise
 * `flooded` when p_flooded ≥ 0.65 and `drained` when p_flooded ≤ 0.35.
 */
export function uncertainState(pFlooded: number | null, validFrac: number): State {
  if (validFrac < VALID_FRAC_MIN || pFlooded === null || (P_DRAINED_MAX < pFlooded && pFlooded < P_FLOODED_MIN)) {
    return "uncertain";
  }
  return pFlooded >= P_FLOODED_MIN ? "flooded" : "drained";
}

/** `|2·p_flooded − 1|`, or null when p_flooded is null. */
export function confidenceFrom(pFlooded: number | null): number | null {
  return pFlooded === null ? null : Math.abs(2 * pFlooded - 1);
}

/** B3.5 step 4, first match wins. */
export function awdVerdict(n: number, d: number, pCatch: number, kStar: number | null, awdMissMax: number): Verdict {
  if (kStar !== null && d >= kStar) return "consistent";
  if (n >= 1 && d === 0 && pCatch >= 1 - awdMissMax) return "inconsistent";
  return "not_enough_evidence";
}

/** B3.5 step 5 (exact text). */
export function awdReason(verdict: Verdict, n: number, d: number, pCatch: number, kStar: number | null): string {
  const looks = looksText(n);
  if (verdict === "consistent") return `Drained on ${d} of ${looks}, more than a continuously flooded field would show.`;
  if (verdict === "inconsistent") {
    return (
      `Flooded on ${allLooksText(n)}; a field practicing AWD would have been caught drained ` +
      `${pctDown(pCatch)}% of the time.`
    );
  }
  if (n === 0) return "No clear looks inside the AWD window.";
  if (d === 0) {
    return (
      `Flooded on ${allLooksText(n)}, but these dates would catch a field practicing AWD only ` +
      `${pctDown(pCatch)}% of the time.`
    );
  }
  if (kStar === null) return `${looks} cannot separate AWD from continuous flooding.`;
  return `Drained on ${d} of ${looks}; ${kStar} are needed to rule out a single drainage.`;
}

/** A clear look in time order (state is `flooded` or `drained`). */
export interface ClearLook {
  readonly ms: number;
  readonly datetime: string;
  readonly stage: Stage;
  readonly state: State;
}

export interface DsrResult {
  signal: DsrSignal;
  reason: string;
}

/** B3.5 step 6. `earlyLooks`: the field's clear looks with stage `early`, sorted by time. */
export function dsrSignal(
  earlyLooks: ReadonlyArray<Pick<ClearLook, "datetime" | "state">>,
  minLooks: number,
  midStart: string,
): DsrResult {
  const n = earlyLooks.length;
  if (n === 0 && minLooks > 0) return { signal: "unknown", reason: `No clear looks before ${midStart}.` };
  if (n < minLooks) return { signal: "unknown", reason: `Only ${looksText(n)} before ${midStart}.` };
  const flooded = earlyLooks.find((lk) => lk.state === "flooded");
  if (flooded) {
    return {
      signal: "transplant_signal",
      reason: `Standing water on ${flooded.datetime.slice(0, 10)}, typical of puddled transplanting.`,
    };
  }
  return { signal: "dsr_signal", reason: `Dry on all ${looksText(n)} before ${midStart}, typical of direct seeding.` };
}

/** The parts of an `observations.jsonl` line the summary reads. */
export interface ObservationInput {
  readonly pass_id: string;
  readonly stage: Stage;
  readonly inferred: { readonly state: State };
}

/** Passes by `pass_id`: a Map or a plain object. */
export type PassLookup<P extends PassTime = PassTime> =
  | ReadonlyMap<string, P>
  | { readonly [passId: string]: P | undefined };

function lookup<P extends PassTime>(passById: PassLookup<P>, id: string): P | undefined {
  if (passById instanceof Map) return passById.get(id);
  return Object.prototype.hasOwnProperty.call(passById, id) ? (passById as Record<string, P | undefined>)[id] : undefined;
}

function byLook(a: ClearLook, b: ClearLook): number {
  // Python sorts (ms, datetime, stage, state) tuples; compare the same keys in the same order (code units).
  if (a.ms !== b.ms) return a.ms - b.ms;
  for (const key of ["datetime", "stage", "state"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/** The field's clear looks on used passes, sorted (B3.5 "Looks"). Throws on an unknown pass_id. */
export function clearLooks(observations: ReadonlyArray<ObservationInput>, passById: PassLookup): ClearLook[] {
  const looks: ClearLook[] = [];
  for (const o of observations) {
    const p = lookup(passById, o.pass_id);
    if (p === undefined) throw new RangeError(`observation names unknown pass_id ${o.pass_id}`);
    const state = o.inferred.state;
    if (p.used && (state === "flooded" || state === "drained")) {
      looks.push({ ms: parseMs(p.datetime), datetime: p.datetime, stage: o.stage, state });
    }
  }
  return looks.sort(byLook);
}

/**
 * B3.5: one `field_summary.jsonl` line. `observations` are this field's lines, `passById` the passes.json
 * entries, `params` = detectability.params, `stages` = aoi.stages. `fixture` is written only when given.
 */
export function fieldSummary(
  fieldId: string,
  observations: ReadonlyArray<ObservationInput>,
  passById: PassLookup,
  params: RuleParams,
  stages: StageBoundaries,
  nSim: number,
  seed: number,
  runId: string,
  fixture?: boolean,
): FieldSummaryLine {
  const looks = clearLooks(observations, passById);
  const [a0, a1] = params.awd_window_days_after_transplant;
  const firstFlooded = looks.find((lk) => lk.stage === "early" && lk.state === "flooded");
  let tMs: number;
  let source: "inferred" | "assumed";
  if (firstFlooded) {
    tMs = firstFlooded.ms;
    source = "inferred";
  } else {
    const tw0 = parseMs(params.transplant_window.start);
    const tw1 = parseMs(params.transplant_window.end);
    tMs = tw0 + Math.floor((tw1 - tw0) / 2);
    source = "assumed";
  }
  const wsMs = tMs + a0 * DAY_MS;
  const weMs = tMs + a1 * DAY_MS;
  const window = { start: fmtDt(wsMs), end: fmtDt(weMs), source };

  const inWindow = looks.filter((lk) => wsMs <= lk.ms && lk.ms < weMs);
  const n = inWindow.length;
  let d = 0;
  for (const lk of inWindow) if (lk.state === "drained") d += 1;
  let pCatch: number;
  let kStar: number | null;
  if (n === 0) {
    pCatch = 0;
    kStar = null;
  } else {
    const simLooks: Look[] = inWindow.map((lk) => [lk.datetime, lk.stage]);
    const key = window.start + "|" + inWindow.map((lk) => lk.datetime).join(",");
    const win = [window.start, window.end] as const;
    const awd = simulate(simLooks, params, nSim, derive(seed, "awd|" + key), "awd", win);
    const cf = simulate(simLooks, params, nSim, derive(seed, "cf|" + key), "cf", win);
    pCatch = ge(awd, 1);
    kStar = kStarFrom(cf, params.cf_false_flag_max);
  }
  const verdict = awdVerdict(n, d, pCatch, kStar, params.awd_miss_max);
  const reason = awdReason(verdict, n, d, pCatch, kStar);
  const dsr = dsrSignal(
    looks.filter((lk) => lk.stage === "early"),
    params.dsr_min_early_looks,
    stages.mid_start,
  );
  return {
    v: 1,
    run_id: runId,
    ...(fixture === undefined ? {} : { fixture }),
    field_id: fieldId,
    awd: { window, clear_looks: n, drained_hits: d, p_catch_ge1_if_awd: pCatch, k_star: kStar, verdict, reason },
    dsr: { signal: dsr.signal, reason: dsr.reason },
  };
}
