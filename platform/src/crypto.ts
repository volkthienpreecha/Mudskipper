/**
 * SHA-256 via WebCrypto (workerd, browsers and Node all expose `crypto.subtle`).
 * TODO(core): use `sha256Hex` from @mudskipper/core so the app, the publish script and the API share one helper.
 */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * CONTRACTS.md B6 step 8: a missing seed is the first 8 hex digits of the input hash as a uint32;
 * audit_id = "a_" + first 16 hex digits of sha256("run_id|input_hash|budget|seed").
 */
export function defaultSeed(inputHash: string): number {
  return Number.parseInt(inputHash.slice(0, 8), 16);
}

export async function auditId(runId: string, inputHash: string, budget: number, seed: number): Promise<string> {
  return "a_" + (await sha256Hex(`${runId}|${inputHash}|${budget}|${seed}`)).slice(0, 16);
}
