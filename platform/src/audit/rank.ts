/**
 * The ranking seam. SPEC A4: ranking exists once, in core/ (`rank.ts`); the platform only calls it.
 *
 * TODO(core): when @mudskipper/core lands on main, replace `defaultRank` with core's implementation:
 *
 *   import { rank, RankError as CoreRankError } from "@mudskipper/core";
 *   export const defaultRank: RankFn = async (...args) => {
 *     try { return await rank(...args); }
 *     catch (e) { if (e instanceof CoreRankError) throw new RankError(e.code, e.message); throw e; }
 *   };
 *
 * and check the argument shapes against core's signature (summaries as a Map or a Record).
 */
import type { AuditRequest, AuditResponse, FieldFeature, FieldSummary } from "../contracts.ts";
import { ApiError } from "../http/errors.ts";

/**
 * core's `rank(request, inputHash, fields, summariesMap, runId, createdAt, fixture)`: CONTRACTS.md B6
 * ranking over a validated request. Returns the whole api/audit_response object.
 */
export type RankFn = (
  request: AuditRequest,
  inputHash: string,
  fields: FieldFeature[],
  summaries: Map<string, FieldSummary>,
  runId: string,
  createdAt: string,
  fixture: boolean,
) => Promise<AuditResponse>;

/** A request the ranking rejects (core throws these); `code` becomes the API error code, HTTP 400. */
export class RankError extends Error {
  readonly code: "duplicate_claim_id" | "invalid_geometry" | "invalid_request";

  constructor(code: RankError["code"], message: string) {
    super(message);
    this.name = "RankError";
    this.code = code;
  }
}

/** Phase 1: core is not on main yet, so ranking answers 501 after every check before it has passed. */
export const notImplementedRank: RankFn = async () => {
  throw new ApiError(
    501,
    "not_implemented",
    "Ranking is not deployed yet: the request is valid, but core/rank.ts has not landed on this deployment.",
  );
};

// TODO(core): `export const defaultRank: RankFn = coreRank;`
export const defaultRank: RankFn = notImplementedRank;
