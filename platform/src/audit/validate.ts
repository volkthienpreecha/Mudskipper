/**
 * POST /api/audit input checks, in the order a client hits them (CONTRACTS.md B6):
 *   413 too_large (> 5 MB, from Content-Length or while streaming) → 400 invalid_json (not UTF-8 / not JSON)
 *   → 400 too_many_claims (> 5,000) → 400 invalid_request (schema api/audit_request)
 *   → 400 invalid_geometry (open or short ring) → 400 duplicate_claim_id.
 * The last two mirror contracts/rules.py `rank`; core/rank.ts throws the same codes (mapped in handler.ts).
 */
import type { AuditRequest } from "../contracts.ts";
import { auditRequest } from "../gen/audit-request.js";
import { ApiError } from "../http/errors.ts";
import { MAX_BODY_BYTES, MAX_CLAIMS } from "../limits.ts";

const tooLarge = () =>
  new ApiError(413, "too_large", `Request body is larger than ${MAX_BODY_BYTES} bytes (5 MB). Split the upload.`);

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

export function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    // V8's message quotes the input; report only the position so an error never echoes uploaded content.
    const pos = /position (\d+)/.exec((e as Error).message)?.[1];
    throw new ApiError(400, "invalid_json", `Request body is not valid JSON${pos ? ` (at byte offset ~${pos})` : ""}.`);
  }
}

function describe(errors: typeof auditRequest.errors): string {
  const e = errors?.[0];
  if (!e) return "Request does not match the api/audit_request schema.";
  const where = e.instancePath === "" ? "request" : e.instancePath;
  return `${where} ${e.message ?? "is invalid"} (schema api/audit_request).`;
}

/** Schema and contract checks on a parsed body; returns the typed request. */
export function validateAuditRequest(body: unknown): AuditRequest {
  const features = (body as { claims?: { features?: unknown } } | null)?.claims?.features;
  if (Array.isArray(features) && features.length > MAX_CLAIMS) {
    throw new ApiError(400, "too_many_claims", `${features.length} claims; the limit is ${MAX_CLAIMS} per request.`);
  }
  if (!auditRequest(body)) throw new ApiError(400, "invalid_request", describe(auditRequest.errors));
  const req = body as AuditRequest;

  const ids = req.claims.features.map((f, i) => f.properties.claim_id ?? `#${i + 1}`);
  req.claims.features.forEach((f, i) => {
    if (f.geometry.type === "Point") return;
    const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
    for (const poly of polys) {
      for (const ring of poly) {
        const a = ring[0];
        const b = ring[ring.length - 1];
        if (ring.length < 4 || !a || !b || a[0] !== b[0] || a[1] !== b[1]) {
          throw new ApiError(
            400,
            "invalid_geometry",
            `claim ${ids[i]}: polygon rings must be closed and have at least 4 positions.`,
          );
        }
      }
    }
  });
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ApiError(400, "duplicate_claim_id", `claim_id '${id}' appears more than once.`);
    seen.add(id);
  }
  return req;
}
