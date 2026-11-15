/**
 * Time in the contract (CONTRACTS.md C0, B3.1, B3.6a). Python reference: `rules.parse_ms`, `rules.fmt_dt`,
 * `rules.days`, `rules.stage_of`, `rules.in_gap`. All arithmetic is on integer epoch milliseconds.
 */
import type { Stage } from "./contracts.gen.ts";

export const DAY_MS = 86_400_000;

/** Stage boundaries as in `aoi.stages` and `detectability.params.stage_boundaries`. */
export interface StageBoundaries {
  readonly mid_start: string;
  readonly late_start: string;
}

/** A closed time interval (both bounds are inside), as in `aoi.gaps`. */
export interface GapInterval {
  readonly start: string;
  readonly end: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0 datetimes are whole seconds with Z. A fraction is accepted (and floored to ms) for robustness, like
// Python's fromisoformat; anything else (offsets, missing Z, missing seconds) is rejected.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/;

function utcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, text: string): number {
  if (y < 1 || mo < 1 || mo > 12 || d < 1) throw new RangeError(`not a valid date: ${JSON.stringify(text)}`);
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d); // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 19xx
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`not a valid date: ${JSON.stringify(text)}`);
  }
  return date.getTime();
}

/** `YYYY-MM-DD` (00:00:00Z on that day) or `YYYY-MM-DDTHH:MM:SSZ` → integer epoch milliseconds. */
export function parseMs(value: string): number {
  const date = DATE_RE.exec(value);
  if (date) return utcMs(Number(date[1]), Number(date[2]), Number(date[3]), 0, 0, 0, value);
  const dt = DATETIME_RE.exec(value);
  if (!dt) throw new RangeError(`expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ, got ${JSON.stringify(value)}`);
  const base = utcMs(Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6]), value);
  const frac = dt[7] === undefined ? 0 : Number(dt[7].padEnd(3, "0").slice(0, 3));
  return base + frac;
}

/** Integer epoch ms → `YYYY-MM-DDTHH:MM:SSZ`, floored to whole seconds (C0 "Datetime in JS"). */
export function fmtDt(ms: number): string {
  if (!Number.isSafeInteger(ms)) throw new RangeError(`fmtDt needs integer milliseconds, got ${ms}`);
  const whole = ms - (((ms % 1000) + 1000) % 1000); // floored modulo, as Python's ms - ms % 1000
  const date = new Date(whole);
  const year = date.getUTCFullYear();
  if (!(year >= 1 && year <= 9999)) throw new RangeError(`fmtDt: year ${year} is outside 1..9999`);
  return date.toISOString().slice(0, 19) + "Z";
}

/** `t(x)` of B3.6a: epoch milliseconds / 86400000 (fractional days). */
export function days(value: string): number {
  return parseMs(value) / DAY_MS;
}

/** early < mid_start ≤ mid < late_start ≤ late (B3.1). */
export function stageOf(datetime: string, stages: StageBoundaries): Stage {
  const ms = parseMs(datetime);
  if (ms < parseMs(stages.mid_start)) return "early";
  if (ms < parseMs(stages.late_start)) return "mid";
  return "late";
}

/** True if `datetime` falls inside any gap; gap intervals are closed (B3.1). */
export function inGap(datetime: string, gaps: Iterable<GapInterval>): boolean {
  const ms = parseMs(datetime);
  for (const g of gaps) {
    if (parseMs(g.start) <= ms && ms <= parseMs(g.end)) return true;
  }
  return false;
}
