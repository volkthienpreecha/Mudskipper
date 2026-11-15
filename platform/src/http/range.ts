/**
 * Byte-range serving (RFC 9110 §14) for /tiles/* when the bytes come from static assets. PMTiles readers fetch
 * a 16 KiB header first (`bytes=0-16383`) and then directory and tile ranges, so this has to be exact:
 * open-ended and suffix ranges, 416 with `Content-Range: bytes * /size`, If-None-Match → 304, If-Range.
 * Multi-range requests are answered with the whole representation (200), which RFC 9110 allows.
 * Preconditions follow RFC 9110 §13.2.2: If-Match (strong comparison) or else If-Unmodified-Since (only when
 * the representation has a modification date) fail with 412, before If-None-Match and Range are looked at.
 */
import { errorBody } from "./errors.ts";
import { applySecurityHeaders, etagMatches } from "./headers.ts";

/** Inclusive byte range. */
export interface ByteRange {
  start: number;
  end: number;
}

export type RangeResult = { kind: "none" } | { kind: "range"; range: ByteRange } | { kind: "unsatisfiable" };

const SPEC = /^bytes=(\d*)-(\d*)$/;

/** Parse a Range header against a representation of `size` bytes. Syntax we do not serve is ignored (200). */
export function parseRange(header: string | null, size: number): RangeResult {
  if (header === null) return { kind: "none" };
  const m = SPEC.exec(header.trim().replace(/\s+/g, ""));
  if (!m) return { kind: "none" }; // other units, multiple ranges or garbage: ignore the header
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return { kind: "none" };
  if (a === "") {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", range: { start: Math.max(0, size - n), end: size - 1 } };
  }
  const start = Number(a);
  const last = b === "" ? size - 1 : Number(b);
  if (b !== "" && last < start) return { kind: "none" }; // invalid range-spec: ignore
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "range", range: { start, end: Math.min(last, size - 1) } };
}

export interface Representation {
  size: number;
  /** Strong ETag, quoted. */
  etag: string;
  contentType: string;
  cacheControl: string;
  /** Modification date, when the store has one (R2 `uploaded`); static assets have none. */
  lastModified?: Date;
  /** Returns the whole body, or exactly the bytes of `range` when given. */
  body(range?: ByteRange): Promise<BodyInit | null>;
}

/** If-Match: `*` or any listed strong ETag equal to `etag` (weak tags never match, RFC 9110 §13.1.1). */
function strongMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  if (etag.startsWith("W/")) return false;
  return header.split(",").some((t) => t.trim() === etag);
}

/** Answer GET/HEAD for a representation with conditional and range semantics. */
export async function serveRepresentation(req: Request, rep: Representation): Promise<Response> {
  const h = new Headers();
  applySecurityHeaders(h);
  h.set("etag", rep.etag);
  h.set("cache-control", rep.cacheControl);
  h.set("accept-ranges", "bytes");
  if (rep.lastModified) h.set("last-modified", rep.lastModified.toUTCString());

  const ifMatch = req.headers.get("if-match");
  const ifUnmodified = req.headers.get("if-unmodified-since");
  const unmodifiedSince = ifUnmodified === null ? NaN : Date.parse(ifUnmodified);
  const failed =
    ifMatch !== null
      ? !strongMatches(ifMatch, rep.etag)
      : rep.lastModified !== undefined && !Number.isNaN(unmodifiedSince) && Math.floor(rep.lastModified.getTime() / 1000) * 1000 > unmodifiedSince;
  if (failed) {
    h.set("content-type", "application/json; charset=utf-8");
    h.set("cache-control", "no-store");
    const msg = ifMatch !== null ? "If-Match does not match the current ETag." : "The file changed after If-Unmodified-Since.";
    return new Response(req.method === "HEAD" ? null : JSON.stringify(errorBody("precondition_failed", msg)), { status: 412, headers: h });
  }

  if (etagMatches(req.headers.get("if-none-match"), rep.etag)) {
    return new Response(null, { status: 304, headers: h });
  }

  let result = parseRange(req.headers.get("range"), rep.size);
  const ifRange = req.headers.get("if-range");
  if (result.kind !== "none" && ifRange !== null && ifRange.trim() !== rep.etag) result = { kind: "none" };

  if (result.kind === "unsatisfiable") {
    h.set("content-range", `bytes */${rep.size}`);
    h.set("content-type", "application/json; charset=utf-8");
    h.set("cache-control", "no-store");
    const msg = `Range ${req.headers.get("range")} is outside the ${rep.size}-byte file.`;
    return new Response(req.method === "HEAD" ? null : JSON.stringify(errorBody("range_not_satisfiable", msg)), {
      status: 416,
      headers: h,
    });
  }

  h.set("content-type", rep.contentType);
  if (result.kind === "range") {
    const { start, end } = result.range;
    h.set("content-range", `bytes ${start}-${end}/${rep.size}`);
    h.set("content-length", String(end - start + 1));
    return new Response(req.method === "HEAD" ? null : await rep.body(result.range), { status: 206, headers: h });
  }
  h.set("content-length", String(rep.size));
  return new Response(req.method === "HEAD" ? null : await rep.body(), { status: 200, headers: h });
}
