/**
 * Numbers and words shown to people (CONTRACTS.md C0, B3.5, B3.6). Python reference: `rules.pct`,
 * `rules.pct_down`, `rules.looks_text`, `rules.all_looks_text`, `rules.passes_text`, `rules.times_text`.
 */

/** Percent shown to people: `floor(100·p + 0.5)`, round half up, identical in Python and TypeScript. */
export function pct(p: number): number {
  return Math.floor(100 * p + 0.5);
}

/** Percent rounded down, `floor(100·p + 1e-9)`, for a probability compared against a threshold (B3.5). */
export function pctDown(p: number): number {
  return Math.floor(100 * p + 1e-9);
}

/** "1 clear look" or "N clear looks". */
export function looksText(n: number): string {
  return n === 1 ? "1 clear look" : `${n} clear looks`;
}

/** "the only clear look" or "all N clear looks". */
export function allLooksText(n: number): string {
  return n === 1 ? "the only clear look" : `all ${n} clear looks`;
}

/** "1 pass" or "N passes". */
export function passesText(n: number): string {
  return n === 1 ? "1 pass" : `${n} passes`;
}

/** "once", "twice" or "k times". */
export function timesText(k: number): string {
  if (k === 1) return "once";
  if (k === 2) return "twice";
  return `${k} times`;
}
