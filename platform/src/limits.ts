/** Fixed texts and limits from SPEC and CONTRACTS.md B6. One place, imported by the API and the scripts. */

/** SPEC D8, verbatim. The same text appears on the site, the project page and the README. */
export const LIMITS_TEXT =
  "No 2026 ground truth in Punjab yet. NISAR revisits every 12 days and has a data gap from Jul 27 to Aug 10, " +
  "2026. Data are provisional. States are inferred without labels. DSR is a signal, not proof. " +
  "We show irrigation evidence, not emissions.";

/**
 * POST /api/audit limits and notice come from core (one copy of the rules, SPEC A4): body ≤ 5 MiB
 * (5,242,880 bytes → 413 too_large), ≤ 5,000 claims (400 too_many_claims), and the B6 notice text
 * (also quoted by the generated OpenAPI spec and developer pages, scripts/lib/openapi.ts and content.ts).
 */
export { MAX_BODY_BYTES, MAX_CLAIMS, NOTICE as AUDIT_NOTICE } from "@mudskipper/core";

/** GET /api/fields page size (B6). */
export const PAGE_SIZE = 500;
