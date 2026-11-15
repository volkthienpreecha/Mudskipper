/**
 * Request checks the API and the fixtures client share (CONTRACTS.md B6), so both answer every query the same
 * way, message included: `GET /api/fields?tile=&verdict=&page=` and the `GET /api/audit/:id` id.
 *
 * - `tile` and `verdict`: absent or empty means no filter; otherwise `tile` must be a tile id (C0) and
 *   `verdict` one of the three verdicts.
 * - `page`: absent or empty means 1; otherwise an integer from 1 to 9,999,999 (as text: 1 to 7 digits, no
 *   leading zero, no sign).
 */
import type { Verdict } from "./contracts.gen.ts";

export const VERDICT_VALUES: ReadonlyArray<Verdict> = ["consistent", "inconsistent", "not_enough_evidence"];
export const TILE_ID_RE = /^[a-z][a-z0-9]{0,15}$/;
export const AUDIT_ID_RE = /^a_[0-9a-f]{16}$/;
export const MAX_PAGE = 9_999_999;
const PAGE_RE = /^[1-9][0-9]{0,6}$/;

/** A query the API answers with 400 `invalid_request`; `message` is the exact text it sends. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export interface FieldsFilter {
  tile: string | null;
  verdict: Verdict | null;
  page: number;
}

const blank = (v: string | number | null | undefined): boolean => v === undefined || v === null || v === "";

export function parseFieldsQuery(raw: {
  tile?: string | null | undefined;
  verdict?: string | null | undefined;
  page?: string | number | null | undefined;
}): FieldsFilter {
  const tile = blank(raw.tile) ? null : String(raw.tile);
  const verdict = blank(raw.verdict) ? null : String(raw.verdict);
  if (tile !== null && !TILE_ID_RE.test(tile)) throw new QueryError(`tile must match ${TILE_ID_RE.source}.`);
  if (verdict !== null && !(VERDICT_VALUES as readonly string[]).includes(verdict)) {
    throw new QueryError(`verdict must be one of ${VERDICT_VALUES.join(", ")}.`);
  }
  let page = 1;
  if (!blank(raw.page)) {
    const p = raw.page!;
    const ok = typeof p === "number" ? Number.isInteger(p) && p >= 1 && p <= MAX_PAGE : PAGE_RE.test(p);
    if (!ok) throw new QueryError(`page must be an integer from 1 to ${MAX_PAGE}.`);
    page = Number(p);
  }
  return { tile, verdict: verdict as Verdict | null, page };
}

export function checkAuditId(id: string): void {
  if (!AUDIT_ID_RE.test(id)) throw new QueryError(`audit id must match ${AUDIT_ID_RE.source}.`);
}
