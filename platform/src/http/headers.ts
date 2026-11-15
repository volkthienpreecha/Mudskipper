/**
 * Response headers for everything a Pages Function returns (`_headers` does not apply to Function responses;
 * static assets get theirs from the `_headers` file written by scripts/build-site.ts).
 */

/** Cache-Control presets, one per kind of response (platform/README.md, "Caching"). */
export const CACHE = {
  /** Liveness and anything per-request. */
  none: "no-store",
  /**
   * Live-scoped API data (/api/meta, /api/fields, …). The URL does not name the run, so it changes when live.json
   * flips; a short max-age plus a strong revalidator (ETag) keeps flips visible within a minute.
   */
  live: "public, max-age=60, stale-while-revalidate=600",
  /** Content-addressed: a stored audit never changes (audit_id is a hash of run, input, budget and seed). */
  immutable: "public, max-age=31536000, immutable",
  /** Run-scoped files of a real run (/tiles/runs/r01/…): a published run_id is never re-used with new bytes. */
  run: "public, max-age=31536000, immutable",
  /** Run-scoped files of the fixture run, which is regenerated in place when the fixtures change. */
  fixtureRun: "public, max-age=300, stale-while-revalidate=86400",
} as const;

/**
 * HTTPS only, for a year, on this host and its preview subdomains (`<branch>.mudskipper-nisar.pages.dev`).
 * No `preload`: a pages.dev subdomain cannot be submitted to the preload list (docs/SECURITY.md, K-341).
 */
export const HSTS = "max-age=31536000; includeSubDomains";

/** Powerful features the site never uses, switched off for every document (static `_headers` too). */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

/** The CSP of every API and tile response: JSON is never a document, so it gets the tightest policy. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Security headers for API and tile responses (docs/SECURITY.md lists every header and why). */
export function applySecurityHeaders(h: Headers): void {
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("content-security-policy", API_CSP);
  h.set("strict-transport-security", HSTS);
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-resource-policy", "cross-origin");
  // Public, read-only data plus an anonymous ranking endpoint: any origin may read it (no credentials).
  h.set("access-control-allow-origin", "*");
  h.set("access-control-expose-headers", "etag, content-range, accept-ranges, content-length, location");
}

/** True if an If-None-Match header matches `etag` (weak comparison, RFC 9110 §13.1.2). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  if (ifNoneMatch.trim() === "*") return true;
  const want = bare(etag);
  return ifNoneMatch.split(",").some((t) => bare(t) === want);
}
