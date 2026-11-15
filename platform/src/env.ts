/**
 * Bindings the Pages Functions may receive. Only ASSETS (always present on Pages) and AUDITS are bound today;
 * DB and DATA appear when the account allows D1 and R2 (wrangler.jsonc). The backend is chosen from what is
 * bound (src/backend.ts), so enabling D1 or R2 is a config change, not a code change.
 */
export interface Bindings {
  /** Pages static assets: the deployed site, including the static API bundle under /data/. */
  ASSETS: Fetcher;
  /** Audit results keyed by audit_id, when D1 is not bound. */
  AUDITS?: KVNamespace;
  /** SPEC B4 database (migrations/0001_init.sql). */
  DB?: D1Database;
  /** SPEC B5 bucket `mudskipper-data`: runs/<run_id>/…, live.json. */
  DATA?: R2Bucket;
  /** Optional override: "static" forces the static bundle even when DB is bound (e.g. while D1 loads). */
  BACKEND?: string;
}

export type AppEnv = { Bindings: Bindings };
