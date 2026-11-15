# platform/ — everything judges touch, on Cloudflare

**Owner:** Karthik · **Live:** <https://mudskipper-nisar.pages.dev> · **Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) steps 2 and 5

`cloudflare-pages` · `pages-functions` · `hono` · `d1` · `r2` · `kv` · `pmtiles` · `http-range` · `vitest` · `wrangler`

One Hono app answers every [CONTRACTS.md B6](../contracts/CONTRACTS.md#b6-http-api) route (plus `GET /api/states`,
B3.13) as **Cloudflare Pages Functions**. The site, the static API bundle and the map files are one Pages
deployment. Response shapes are pinned by [`contracts/schemas/api`](../contracts/schemas/api) and checked against
[`contracts/fixtures/api`](../contracts/fixtures/api) on every test run, on both storage backends.

## Architecture

```
                         https://mudskipper-nisar.pages.dev   (Pages project mudskipper-nisar, branch main)
                                          │
              _routes.json: /api, /api/*, /tiles/* ──► Pages Functions ──────────────┐
              everything else ──► static assets (SPA fallback to index.html)        │
                                          │                                          ▼
 ┌──────────── static assets (platform/.site) ────────────┐        functions/api/[[path]].ts
 │ index.html  app/dist, or placeholder/ when no app yet  │        functions/tiles/[[path]].ts
 │ og.png  favicon.svg  fonts/  robots.txt  sitemap.xml   │                 │ hono/cloudflare-pages
 │ _headers (CSP, nosniff, cache)  _routes.json           │                 ▼
 │ data/live.json                                         │◄──┐     src/app.ts  (one Hono app)
 │ data/runs/<run_id>/manifest.json                       │   │      ├─ src/backend.ts  picks by binding:
 │ data/runs/<run_id>/api/{meta,story,…}.json             │   │      │   data   : D1Repo if DB, else StaticRepo
 │ data/runs/<run_id>/api/fields.json, fields/<id>.json   │   │      │   audits : D1 `audits` if DB, else KV AUDITS
 │ data/runs/<run_id>/{fields.geojson,overlays/,hist/,…}  │   │      │   tiles  : R2 DATA if bound, else /data/
 └────────────────────────────────────────────────────────┘   │      ├─ src/repo/static.ts ── ASSETS.fetch ┘
      ▲ written by scripts/build-bundle.ts (same builder       │      ├─ src/repo/d1.ts ─────── D1 (B4 tables)   [when enabled]
      │ as the D1 loader: src/shapes.ts)                       │      ├─ src/tiles.ts ───────── Range/206/416/304
 artifacts/<run_id>/ or contracts/fixtures/run ──► publish ────┘      └─ src/audit/* ───────── validate → hash → rank (core) → store
```

- **One builder, two backends.** `src/shapes.ts` builds every run-scoped response. The bundle builder writes them
  as files; the D1 loader writes the same objects into tables and `docs`. Tests run every route on both and
  compare with the fixtures by parsed value, so switching backends cannot change a response.
- **Per-isolate caches.** Parsed manifests, documents and the field list are reused for the isolate's lifetime
  (static) or 15–60 s (D1), which keeps requests inside the free plan's 10 ms CPU.

## Routes

| Route | Response | Cache-Control |
|---|---|---|
| `GET /api` | endpoint index | `public, max-age=300` |
| `GET /api/health` | `api/health` (`time` = now) | `no-store` |
| `GET /api/{meta,story,passes,states,detectability,checks,provenance}` | the run document + `fixture` | `public, max-age=60, stale-while-revalidate=600` + ETag (304) |
| `GET /api/fields?tile=&verdict=&page=` | `api/fields_page`, 500 per page, by `field_id` | same, 400 on bad params |
| `GET /api/fields/:id` | `api/field_detail` | same, 404 `not_found` |
| `POST /api/audit` | `api/audit_response`, 201 + `Location` (200 if already stored) | `no-store` |
| `GET /api/audit/:id` | stored `api/audit_response` | `public, max-age=31536000, immutable` |
| `GET /tiles/runs/<run_id>/<file>` | bytes, Range → 206, 416, If-None-Match → 304 | real run: 1 year immutable; `fixture`: 5 min |

Errors are only `{"error":{"code","message"}}`: `invalid_json`, `invalid_request`, `too_large` (413, body > 5 MB,
checked from `Content-Length` and while streaming), `too_many_claims` (> 5,000), `duplicate_claim_id`,
`invalid_geometry`, `not_found`, `method_not_allowed` (405 + `Allow`), `range_not_satisfiable`, `no_live_run`
(503), `storage_unavailable` (503), `internal` (500, never echoes input). Unknown `/api/*`
paths are JSON 404s. Error messages never quote the uploaded body, and audits store only the ranking (no
geometry), so nothing personal is kept.

**Headers.** Function responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'none'`, CORS `*` (public data,
no credentials). Static assets (`_headers`): the same, plus a hash-based CSP for the placeholder page
(`script-src`/`style-src` pinned to the sha256 of its one inline script and stylesheet).

**Range on Pages.** Pages static assets ignore `Range` (verified on the live site: `/data/…` answers 200 with
the whole file), so `/tiles/*` computes ranges itself from the manifest's size and sha256 (strong ETag), asks
ASSETS for the bytes and slices them when needed. With R2 bound it uses `head()` + ranged `get()` and the same
range code, so both backends answer identically (tests cover suffix, open-ended, 416, If-None-Match, If-Range,
multi-range and HEAD).

## Storage backends

| | Static (live today) | D1 + R2 (ready; needs the owner) |
|---|---|---|
| API data | JSON files under `/data/runs/<id>/api/` in the deployment | SPEC B4 tables + `docs` (`migrations/0001_init.sql`) |
| live pointer | `/data/live.json`, shipped with the deploy | R2 `live.json` (or D1 `meta.live` without R2), flipped last |
| audits | KV namespace `mudskipper-audits` (binding `AUDITS`) | D1 `audits` |
| /tiles | `/data/runs/<id>/…` with Function-side ranges | R2 `mudskipper-data` with ranged reads |

**D1 schema notes** (each deviation is commented in the migration): `run_id` is part of every primary key so
runs coexist; every table is `WITHOUT ROWID` and `STRICT` with **no secondary indexes**, so one changed row is
one row written (free plan: 100,000 per day). The loader diffs against what the database holds and sends
`INSERT … ON CONFLICT … DO UPDATE … WHERE <a column differs>` in statements of at most 100 bound parameters, so
a second load of the same run writes 0 rows. Measured locally on the fixture run: first load 3,620 expected and
3,620 written; second load 0; a forced full upsert (683 statements) 0.

## Scripts

All are plain `node` (Node 24 runs the TypeScript directly) and print `--help`.

| Command | What it does |
|---|---|
| `make publish FIXTURES=1` / `make publish RUN_ID=r01` | `scripts/publish.ts`: preflight → compute-run + district table → `validate.py --recompute` → republish guard → bundle + site → (D1 load, R2 upload) → `wrangler pages deploy … --branch main` → smoke → flip live. `ARGS=--dry-run` prints the preflight and the plan. |
| `make smoke` (`BASE=…`) | `scripts/smoke.ts`: every endpoint schema-validated, T8 fixture flag, Range 206/416/304, audit POST (golden ranking while the fixture run is live) + GET round trip, SPA fallback, timings |
| `npm run build:site -w platform -- --fixtures` | `scripts/build-site.ts` → `platform/.site/` (app/dist or placeholder, `/data/` bundle, `_routes.json`, `_headers`, robots, sitemap) |
| `npm run build:bundle -w platform -- --run DIR` | `scripts/build-bundle.ts`: every API response validated, then written; deterministic |
| `npm run load-d1 -w platform -- --fixtures --local` | `scripts/load-d1.ts`: `--local`/`--remote`, `--dry-run`, `--budget 90000`, `--allow-over-budget`, `--live`, `--full` |
| `npm run og -w platform` | `scripts/og.ts`: `og.png` (1200×630, headless Chrome + the self-hosted fonts) and the raster icons |
| `npm run gen -w platform` | `scripts/gen-validators.ts`: Ajv standalone response validators for the workerd tests (workerd forbids `new Function`) |
| `npm run dev -w platform` | `wrangler pages dev` on `.site` (build it first) |
| `npm run typecheck -w platform` / `npm test -w platform` | `wrangler types --check`, generated-code drift, tsc on runtime and scripts; Vitest (workerd + Node + a real `wrangler pages dev` smoke) |

## Deploy

- **Account:** Cloudflare `e5e342f3ca2f33158f6f1dd40c039be0` (the scripts pin `CLOUDFLARE_ACCOUNT_ID`).
  Locally, `wrangler login` (OAuth) is enough.
- **URL rule:** only `mudskipper-nisar.pages.dev` (no workers.dev, no autogenerated prefixes). `publish.ts` fails
  if wrangler ever reports a workers.dev URL.
- **CI** (`.github/workflows/platform.yml`): typecheck, tests and the fixture build on every PR and push. On
  `main` it deploys the fixture site and smoke-tests production, but only when the repository has the
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, and never over a real run (it reads `live.json`
  first). Without the secrets the job succeeds with a notice.

## One-time steps for the owner

1. **CI secrets** (repo admin, Settings → Secrets and variables → Actions): `CLOUDFLARE_ACCOUNT_ID` =
   `e5e342f3ca2f33158f6f1dd40c039be0`, and `CLOUDFLARE_API_TOKEN` from a token with *Account · Cloudflare Pages ·
   Edit*, *Account · Workers KV Storage · Edit*, *Account · D1 · Edit*, *Account · Workers R2 Storage · Edit*,
   *Account · Account Settings · Read*, scoped to that account only.
2. **Switch to D1** (the account is at the free plan's 10-database limit): delete an unused database or move to
   Workers Paid, then
   ```sh
   npx wrangler d1 create mudskipper            # in platform/, with CLOUDFLARE_ACCOUNT_ID set
   ```
   uncomment `d1_databases` in `wrangler.jsonc`, paste the `database_id`, run `npm run types -w platform`, and
   `make publish RUN_ID=r01`. Publish then applies migrations, loads D1 (refusing a load over 90,000 expected
   rows unless `ARGS=--allow-over-budget`), deploys and flips `meta.live`. `BACKEND=static` (a Pages
   environment variable) forces the bundle back without a code change.
3. **Enable R2** (dashboard → R2 → enable; free tier), `npx wrangler r2 bucket create mudskipper-data`, uncomment
   `r2_buckets`, run `npm run types -w platform`, publish. `/tiles/*` and `live.json` then come from R2.

## core inside the platform

The rules exist once, in [`core/`](../core) (SPEC A4), and the platform only calls them:

- `POST /api/audit`: core's `readAuditBody` (strict UTF-8 JSON + sha256 of the exact bytes),
  `validateAuditRequest` (the request schema, no dependencies) and `rank`; a core `RankError` becomes the API
  error with its own status and code. The platform adds the streaming 5 MiB cap and storage. POSTing the exact
  bytes of `contracts/fixtures/api/audit.request.json` returns `audit.response.json` (created_at aside), in
  workerd, under `wrangler pages dev` and on production (the smoke test checks it).
- Types: `src/contracts.ts` re-exports the generated `@mudskipper/core/contracts`.
- `publish --run <id>`: `node core/scripts/compute-run.ts`, then `make district`, then compute-run again to
  re-list provenance, before validation.
- Type checking: core is written against `lib: WebWorker` (DECISIONS.md K-202), which workerd's generated runtime
  types reject in two places, so both tsconfig projects use the web-standard globals plus a structural binding
  subset (`types/workers.d.ts`); `wrangler types --include-runtime=false` still generates `Env` and CI checks it.

## Publishing the real run

`make publish RUN_ID=r01 ARGS=--dry-run` prints a preflight of the run directory (present, missing with its
owner, optional, made by publish) and the steps. Today `artifacts/r01` has only the geo files; it is waiting on
the pipeline's `passes.json`, `observations.jsonl`, `provenance.json` and `overlays/index.json`, and
`detectability.param_sources.drained_fraction_of_cycle` still needs a citation before `validate.py` accepts a
real run.
