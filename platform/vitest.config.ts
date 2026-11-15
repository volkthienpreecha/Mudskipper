/**
 * Two test projects:
 *  - workers: every route on both backends, inside workerd (@cloudflare/vitest-plugin), with real local D1, KV
 *    and R2 from Miniflare and an ASSETS binding that serves the fixture bundle like Pages does (SPA fallback
 *    for missing files, no Range support; a second binding honours Range to cover the pass-through path).
 *  - node: the scripts (bundle builder, D1 loader CLI, site assembly + `wrangler pages dev` smoke).
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildBundle } from "./scripts/build-bundle.ts";
import { FIXTURE_RUN, REPO_ROOT } from "./scripts/lib/run.ts";
import { readRun } from "./scripts/lib/run.ts";

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};

/** A Pages-like static asset server over `root`: SPA fallback (index.html, 200) for anything missing. */
function pagesAssets(root: string, honourRange: boolean) {
  return async (request: Request): Promise<Response> => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = join(root, path);
    if (!path.includes("..") && existsSync(file) && statSync(file).isFile()) {
      const data = readFileSync(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (honourRange && m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), data.byteLength - 1);
        return new Response(data.subarray(start, end + 1), {
          status: 206,
          headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${data.byteLength}` },
        });
      }
      return new Response(data, { headers: { "content-type": type } });
    }
    return new Response("<!doctype html><title>SPA</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => {
            const site = mkdtempSync(join(tmpdir(), "mudskipper-test-site-"));
            buildBundle(FIXTURE_RUN, { out: join(site, "data"), fixtureLive: true });
            const empty = mkdtempSync(join(tmpdir(), "mudskipper-empty-site-"));
            const apiDir = join(REPO_ROOT, "contracts", "fixtures", "api");
            const fixtureApi = Object.fromEntries(
              readdirSync(apiDir)
                .filter((n) => n.endsWith(".json") && n !== "audit.request.json")
                .map((n) => [n.replace(/\.json$/, ""), JSON.parse(readFileSync(join(apiDir, n), "utf8"))]),
            );
            return {
              miniflare: {
                compatibilityDate: "2026-11-13",
                d1Databases: ["DB"],
                kvNamespaces: ["AUDITS"],
                r2Buckets: ["DATA"],
                bindings: {
                  TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, "migrations")),
                  TEST_RUN: readRun(FIXTURE_RUN) as never, // plain JSON data; Miniflare types bindings as Json
                  TEST_FIXTURE_API: fixtureApi,
                  TEST_AUDIT_REQUEST: readFileSync(join(apiDir, "audit.request.json"), "utf8"),
                },
                serviceBindings: {
                  ASSETS: pagesAssets(site, false),
                  ASSETS_RANGE: pagesAssets(site, true),
                  ASSETS_EMPTY: pagesAssets(empty, false),
                },
              },
            };
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          setupFiles: ["./test/workers/setup.ts"],
        },
      },
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
