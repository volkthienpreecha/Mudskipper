// Test-only bindings configured in vitest.config.ts (Miniflare), merged into the generated Cloudflare.Env.
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    ASSETS_RANGE: Fetcher;
    ASSETS_EMPTY: Fetcher;
    DB: D1Database;
    DATA: R2Bucket;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_RUN: import("../../src/shapes.ts").RunData;
    TEST_FIXTURE_API: Record<string, Record<string, unknown>>;
    TEST_AUDIT_REQUEST: string;
  }
}
