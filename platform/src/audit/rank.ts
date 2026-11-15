/**
 * The ranking seam. SPEC A4: ranking exists once, in core (`core/src/rank.ts`); the platform calls it. The
 * seam stays a parameter of createApp so tests can inject failures and doubles.
 */
import { rank as coreRank, RankError } from "@mudskipper/core";
import type { AuditRequest, AuditResponse, FieldFeature, FieldSummary } from "../contracts.ts";

export { RankError };

/** core's `rank(request, inputHash, fields, summariesMap, runId, createdAt, fixture)` (CONTRACTS.md B6). */
export type RankFn = (
  request: AuditRequest,
  inputHash: string,
  fields: FieldFeature[],
  summaries: Map<string, FieldSummary>,
  runId: string,
  createdAt: string,
  fixture: boolean,
) => Promise<AuditResponse>;

export const defaultRank: RankFn = coreRank;
