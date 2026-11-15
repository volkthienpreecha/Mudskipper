/**
 * POST /api/audit input, in the order a client hits the checks (CONTRACTS.md B6, DECISIONS.md K-307):
 *   413 too_large (> 5 MiB, from Content-Length, or while streaming so a large body is never buffered: here)
 *   → 400 invalid_json (not strict UTF-8 JSON) and the sha256 of the exact bytes (core `readAuditBody`)
 *   → 400 invalid_request / too_many_claims (core `validateAuditRequest`, the schema with no dependencies)
 *   → 400 duplicate_claim_id / invalid_geometry (core `rank`).
 * Every failure is a core `RankError`; `toApiError` turns it into the API error shape. Messages never quote
 * the uploaded body.
 */
import { MAX_BODY_BYTES, RankError, readAuditBody, validateAuditRequest } from "@mudskipper/core";
import type { AuditRequest } from "../contracts.ts";
import { ApiError, type ErrorCode } from "../http/errors.ts";

const tooLarge = () =>
  new ApiError(413, "too_large", `Request body is larger than ${MAX_BODY_BYTES} bytes (5 MiB). Split the upload.`);

/** Read the exact request bytes, refusing more than MAX_BODY_BYTES without buffering them. */
export async function readBodyCapped(req: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    await req.body?.cancel();
    throw tooLarge();
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** A core RankError as the API error (status from core: 413 for too_large, else 400). */
export function toApiError(e: RankError): ApiError {
  const message = e.message.charAt(0).toUpperCase() + e.message.slice(1) + (/[.!?]$/.test(e.message) ? "" : ".");
  return new ApiError(e.status, e.code as ErrorCode, message);
}

/** Parse, hash and schema-check a body with core's helpers. */
export async function parseAuditBody(bytes: Uint8Array<ArrayBuffer>): Promise<{ request: AuditRequest; inputHash: string }> {
  try {
    const { request, inputHash } = await readAuditBody(bytes);
    return { request: validateAuditRequest(request), inputHash };
  } catch (e) {
    if (e instanceof RankError) throw toApiError(e);
    throw e;
  }
}
