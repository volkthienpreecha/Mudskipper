/**
 * The ranking seam. SPEC A4: ranking exists once, in core (`core/src/rank.ts`); the platform calls it. The
 * seam stays a parameter of createApp so tests can inject failures and doubles.
 */
import { rank as coreRank, RankError, type FieldIndex, type RankField, type RankSummary } from "@mudskipper/core";
import type { AuditRequest, AuditResponse } from "../contracts.ts";

export { RankError };

/**
 * core's `rank(request, inputHash, fields, summaries, runId, createdAt, fixture)` (CONTRACTS.md B6), called with
 * the run's prebuilt spatial index (repo.rankInputs, kept per isolate) in place of the field list.
 */
export type RankFn = (
  request: AuditRequest,
  inputHash: string,
  fields: FieldIndex<RankField>,
  summaries: ReadonlyMap<string, RankSummary>,
  runId: string,
  createdAt: string,
  fixture: boolean,
) => Promise<AuditResponse>;

export const defaultRank: RankFn = coreRank;
