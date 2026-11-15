/**
 * CONTRACTS.md B6 step 8 ids. Hashing is core's `sha256Hex` (WebCrypto), so the app, the publish script and
 * the API share one helper. The platform computes `audit_id` before ranking only to find a stored result
 * without re-ranking; core's `rank` computes the same id and the tests assert they agree.
 */
import { seedFor, sha256Hex } from "@mudskipper/core";

export { sha256Hex };

/** The request's seed, or the first 8 hex digits of the input hash as a uint32. */
export function defaultSeed(inputHash: string): number {
  return seedFor({}, inputHash);
}

/** audit_id = "a_" + first 16 hex digits of sha256("run_id|input_hash|budget|seed"). */
export async function auditId(runId: string, inputHash: string, budget: number, seed: number): Promise<string> {
  return "a_" + (await sha256Hex(`${runId}|${inputHash}|${budget}|${seed}`)).slice(0, 16);
}
