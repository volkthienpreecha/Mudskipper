/** Fixed texts and limits from SPEC and CONTRACTS.md B6. One place, imported by the API and the scripts. */

/** SPEC D8, verbatim. The same text appears on the site, the project page and the README. */
export const LIMITS_TEXT =
  "No 2026 ground truth in Punjab yet. NISAR revisits every 12 days and has a data gap from Jul 27 to Aug 10, " +
  "2026. Data are provisional. States are inferred without labels. DSR is a signal, not proof. " +
  "We show irrigation evidence, not emissions.";

/** CONTRACTS.md B6 ranking output, always this exact string. */
export const AUDIT_NOTICE = "Ranking for inspection, not a finding about anyone.";

/** POST /api/audit body limit (B6: body ≤ 5 MB → 413 too_large). 5 MB = 5 × 1024 × 1024 bytes. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** POST /api/audit claim limit (B6: ≤ 5,000 claims → 400 too_many_claims). */
export const MAX_CLAIMS = 5000;

/** GET /api/fields page size (B6). */
export const PAGE_SIZE = 500;

/** Contract version carried by every response (C0). */
export const CONTRACT_VERSION = 1;
