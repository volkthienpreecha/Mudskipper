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
 │ data/runs/<run_id>/api/pages/, fields/<id>.json, rank.bin │   │      │   audits : D1 `audits` if DB, else KV AUDITS
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
`invalid_geometry`, `rate_limited` (429 + `Retry-After`), `not_found`, `method_not_allowed` (405 + `Allow`),
`range_not_satisfiable`, `precondition_failed` (412), `no_live_run`
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
| `make publish FIXTURES=1` / `make publish RUN_ID=r01` | `scripts/publish.ts`: preflight → compute-run + district table → `validate.py --recompute` → republish guard → app + bundle + site → (D1 load, R2 upload) → deploy the `staging` preview → smoke it → app for the production origin, carry the previous run's tiles → deploy production → smoke it → mirror live (K-318). `--branch NAME` publishes a preview only. `ARGS=--dry-run` prints the preflight and the plan. |
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

## Performance

Measured on the Workers Free plan (10 ms CPU per request, 128 MB, 50 subrequests) with `node scripts/perf.ts`,
which tags each request and reads its `cpuTime` from `wrangler pages deployment tail` (Cloudflare's own
accounting), re-sending requests the tail sampled away. Budgets: CPU p95 ≤ 8 ms, no 1102 or 5xx, read p95
latency ≤ 600 ms. Run: the rehearsal `x01` (DECISIONS.md K-312): r01's real 4,599 FTW fields and PMTiles, the
10 planned track-84 passes, SAMPLE radar values, on the `rehearsal` preview only.

```sh
python3 platform/scripts/rehearsal/make_rehearsal.py                                   # → platform/.rehearsal/x01
node scripts/publish.ts --run x01 --run-dir .rehearsal/x01 --branch rehearsal          # real pipeline, preview only
node scripts/perf.ts --base https://rehearsal.mudskipper-nisar.pages.dev --samples 20  # remote, CPU from the tail
node scripts/perf.ts --local .site                                                     # in-process, JS-thread CPU
```

**Before** (main's code, preview `0b27fcbe`, 5 samples per row):

| endpoint | n | status | latency p50 / p95 / max (ms) | CPU p50 / p95 / max (ms) | outcome | avg bytes | budget |
|---|---:|---|---:|---:|---|---:|---|
| GET /api/health | 5 | 200×5 | 43 / 149 / 149 | 1.0 / 5.0 / 5.0 | ok×5 | 0.1 kB | ok |
| GET /api/meta | 5 | 200×5 | 44 / 60 / 60 | 1.0 / 2.0 / 2.0 | ok×5 | 1.3 kB | ok |
| GET /api/story | 5 | 200×5 | 45 / 256 / 256 | 1.0 / 6.0 / 6.0 | ok×5 | 0.3 kB | ok |
| GET /api/passes | 5 | 200×5 | 42 / 46 / 46 | 0.0 / 1.0 / 1.0 | ok×5 | 4.2 kB | ok |
| GET /api/states | 5 | 200×5 | 55 / 211 / 211 | 1.0 / 14.0 / 14.0 | ok×5 | 130.5 kB | **CPU p95 14.0 ms > 8** |
| GET /api/detectability | 5 | 200×5 | 48 / 62 / 62 | 1.0 / 2.0 / 2.0 | ok×5 | 4.3 kB | ok |
| GET /api/checks | 5 | 200×5 | 51 / 58 / 58 | 1.0 / 2.0 / 2.0 | ok×5 | 1.1 kB | ok |
| GET /api/provenance | 5 | 200×5 | 35 / 49 / 49 | 1.0 / 3.0 / 3.0 | ok×5 | 6.3 kB | ok |
| GET /api/meta If-None-Match (304) | 5 | 304×5 | 43 / 134 / 134 | 0.0 / 2.0 / 2.0 | ok×5 | 0.0 kB | ok |
| GET /api/fields?page=N (every page + 1 past the end) | 11 | 200×11 | 38 / 58 / 58 | 1.0 / 8.0 / 8.0 | ok×11 | 113.2 kB | ok |
| GET /api/fields?tile=T&page=N (every page) | 11 | 200×11 | 37 / 130 / 130 | 1.0 / 2.0 / 2.0 | ok×11 | 113.2 kB | ok |
| GET /api/fields?tile=T&verdict=V | 6 | 200×6 | 33 / 57 / 57 | 1.0 / 7.0 / 7.0 | ok×6 | 98.9 kB | ok |
| GET /api/fields?verdict=V&page=N | 6 | 200×6 | 33 / 163 / 163 | 1.0 / 2.0 / 2.0 | ok×6 | 108.9 kB | ok |
| GET /api/fields?tile=unknown (empty) | 1 | 200×1 | 32 / 32 / 32 | 1.0 / 1.0 / 1.0 | ok×1 | 0.1 kB | ok |
| GET /api/fields/:id (spread over the run) | 60 | 200×60 | 41 / 57 / 212 | 1.0 / 2.0 / 2.0 (48 of 60) | ok×48 ?×12 | 4.0 kB | ok |
| GET /api/fields/:id unknown (404) | 2 | 404×2 | 32 / 39 / 39 | 1.0 / 1.0 / 1.0 | ok×2 | 0.1 kB | ok |
| GET /tiles fields.pmtiles header (bytes=0-16383) | 5 | 206×5 | 61 / 64 / 64 | 3.0 / 4.0 / 4.0 (4 of 5) | ?×1 ok×4 | 16.0 kB | ok |
| GET /tiles fields.pmtiles root directory | 5 | 206×5 | 60 / 70 / 70 | 2.0 / 5.0 / 5.0 | ok×5 | 3.5 kB | ok |
| GET /tiles fields.pmtiles metadata | 5 | 206×5 | 54 / 74 / 74 | 2.0 / 5.0 / 5.0 (4 of 5) | ?×1 ok×4 | 1.7 kB | ok |
| GET /tiles fields.pmtiles tile range (2-64 KiB) | 20 | 206×20 | 61 / 91 / 97 | 3.0 / 11.0 / 11.0 (16 of 20) | ok×16 ?×4 | 28.1 kB | **CPU p95 11.0 ms > 8** |
| GET /tiles fields.geojson (whole file) | 3 | 200×3 | 142 / 169 / 169 | 1.0 / 7.0 / 7.0 | ok×3 | 3.67 MB | ok |
| GET /tiles overlay PNG | 5 | 200×5 | 46 / 49 / 49 | 1.0 / 1.0 / 1.0 (4 of 5) | ?×1 ok×4 | 26.8 kB | ok |
| GET /tiles hist PNG | 3 | 200×3 | 46 / 47 / 47 | 1.0 / 1.0 / 1.0 (2 of 3) | ok×2 ?×1 | 2.1 kB | ok |
| POST /api/audit 60 claims | 3 | 201×3 | 446 / 515 / 515 | 12.0 / 107.0 / 107.0 | ok×3 | 11.4 kB | **CPU p95 107.0 ms > 8** |
| POST /api/audit 500 claims | 3 | 201×3 | 509 / 795 / 795 | 40.0 / 220.0 / 220.0 | ok×3 | 19.6 kB | **CPU p95 220.0 ms > 8** |
| POST /api/audit 2000 claims | 3 | 201×3 | 653 / 755 / 755 | 109.0 / 185.0 / 185.0 | ok×3 | 19.6 kB | **CPU p95 185.0 ms > 8** |
| POST /api/audit 5000 claims | 3 | 201×3 | 788 / 805 / 805 | 235.0 / 285.0 / 285.0 | ok×3 | 20.2 kB | **CPU p95 285.0 ms > 8** |
| POST /api/audit 5 MiB of polygons (5000 claims) | 2 | 201×2 | 1201 / 1333 / 1333 | 389.0 / 587.0 / 587.0 | ok×2 | 20.4 kB | **CPU p95 587.0 ms > 8** |

**After** (this code, preview `2019cf99`, 20 samples per read row):

| endpoint | n | status | latency p50 / p95 / max (ms) | CPU p50 / p95 / max (ms) | outcome | avg bytes | budget |
|---|---:|---|---:|---:|---|---:|---|
| GET /api/health | 20 | 200×20 | 45 / 198 / 204 | 1.0 / 6.0 / 10.0 | ok×20 | 0.1 kB | ok |
| GET /api/meta | 20 | 200×20 | 51 / 89 / 208 | 1.0 / 6.0 / 7.0 | ok×20 | 1.3 kB | ok |
| GET /api/story | 20 | 200×20 | 50 / 142 / 262 | 1.0 / 2.0 / 3.0 | ok×20 | 0.3 kB | ok |
| GET /api/passes | 20 | 200×20 | 46 / 80 / 179 | 1.0 / 1.0 / 5.0 | ok×20 | 4.2 kB | ok |
| GET /api/states | 20 | 200×20 | 51 / 73 / 81 | 1.0 / 1.0 / 2.0 | ok×20 | 130.5 kB | ok |
| GET /api/detectability | 20 | 200×20 | 44 / 60 / 83 | 1.0 / 1.0 / 1.0 (16 of 20) | ok×16 ?×4 | 4.6 kB | ok |
| GET /api/checks | 20 | 200×20 | 44 / 54 / 56 | 1.0 / 1.0 / 1.0 (14 of 20) | ok×14 ?×6 | 1.1 kB | ok |
| GET /api/provenance | 20 | 200×20 | 46 / 53 / 193 | 1.0 / 3.0 / 3.0 (15 of 20) | ?×5 ok×15 | 6.3 kB | ok |
| GET /api/meta If-None-Match (304) | 20 | 304×20 | 44 / 55 / 56 | 1.0 / 2.0 / 2.0 (15 of 20) | ?×5 ok×15 | 0.0 kB | ok |
| GET /api/fields?page=N (every page + 1 past the end) | 11 | 200×11 | 49 / 59 / 59 | 1.0 / 1.0 / 1.0 (9 of 11) | ok×9 ?×2 | 113.2 kB | ok |
| GET /api/fields?tile=T&page=N (every page) | 11 | 200×11 | 55 / 59 / 59 | 1.0 / 2.0 / 2.0 (10 of 11) | ok×10 ?×1 | 113.2 kB | ok |
| GET /api/fields?tile=T&verdict=V | 6 | 200×6 | 44 / 57 / 57 | 0.0 / 1.0 / 1.0 (4 of 6) | ?×2 ok×4 | 98.9 kB | ok |
| GET /api/fields?verdict=V&page=N | 6 | 200×6 | 51 / 92 / 92 | 1.0 / 1.0 / 1.0 (5 of 6) | ok×5 ?×1 | 108.9 kB | ok |
| GET /api/fields?tile=unknown (empty) | 1 | 200×1 | 64 / 64 / 64 | 2.0 / 2.0 / 2.0 | ok×1 | 0.1 kB | ok |
| GET /api/fields/:id (spread over the run) | 60 | 200×60 | 46 / 56 / 67 | 1.0 / 2.0 / 2.0 (50 of 60) | ok×50 ?×10 | 4.0 kB | ok |
| GET /api/fields/:id unknown (404) | 2 | 404×2 | 56 / 71 / 71 | 0.0 / 1.0 / 1.0 | ok×2 | 0.1 kB | ok |
| GET /tiles fields.pmtiles header (bytes=0-16383) | 20 | 206×20 | 35 / 48 / 82 | 1.0 / 6.0 / 6.0 (16 of 20) | ok×16 ?×4 | 16.0 kB | ok |
| GET /tiles fields.pmtiles root directory | 20 | 206×20 | 32 / 40 / 46 | 1.0 / 3.0 / 3.0 (17 of 20) | ok×17 ?×3 | 3.5 kB | ok |
| GET /tiles fields.pmtiles metadata | 20 | 206×20 | 32 / 40 / 46 | 1.0 / 3.0 / 3.0 (15 of 20) | ok×15 ?×5 | 1.7 kB | ok |
| GET /tiles fields.pmtiles tile range (2-64 KiB) | 80 | 206×80 | 37 / 51 / 56 | 1.0 / 3.0 / 5.0 (66 of 80) | ok×66 ?×14 | 32.4 kB | ok |
| GET /tiles fields.geojson (whole file) | 3 | 200×3 | 166 / 212 / 212 | 0.0 / 1.0 / 1.0 (2 of 3) | ok×2 ?×1 | 3.67 MB | ok |
| GET /tiles overlay PNG | 20 | 200×20 | 55 / 220 / 482 | 1.0 / 2.0 / 2.0 (18 of 20) | ok×18 ?×2 | 29.4 kB | ok |
| GET /tiles hist PNG | 3 | 200×3 | 45 / 47 / 47 | 1.0 / 1.0 / 1.0 | ok×3 | 2.1 kB | ok |
| POST /api/audit 60 claims | 5 | 201×5 | 426 / 568 / 568 | 8.0 / 32.0 / 32.0 | ok×5 | 11.8 kB | **CPU p95 32.0 ms > 8** |
| POST /api/audit 500 claims | 5 | 201×5 | 466 / 672 / 672 | 30.0 / 33.0 / 33.0 | ok×5 | 19.7 kB | **CPU p95 33.0 ms > 8** |
| POST /api/audit 2000 claims | 5 | 201×5 | 542 / 560 / 560 | 63.0 / 91.0 / 91.0 | ok×5 | 19.8 kB | **CPU p95 91.0 ms > 8** |
| POST /api/audit 5000 claims | 5 | 201×5 | 866 / 1049 / 1049 | 129.0 / 159.0 / 159.0 | ok×5 | 20.0 kB | **CPU p95 159.0 ms > 8** |
| POST /api/audit 5 MiB of polygons (5000 claims) | 2 | 201×2 | 967 / 1273 / 1273 | 165.0 / 235.0 / 235.0 | ok×2 | 20.3 kB | **CPU p95 235.0 ms > 8** |

What changed (K-313, K-314): every run document, every `/api/fields` page of every filter and every field card is
pre-serialized at bundle time and streamed without `JSON.parse`; audits read `api/rank.bin` (typed arrays and the
grid of core's `fieldIndex`) instead of parsing 3.8 MB of GeoJSON, and match claims through the grid instead of
scanning every field; `/tiles` keeps whole files ≤ 8 MiB per isolate for ranged reads. Every read is now 0–2 ms
CPU at p50 and inside the budget at p95; the remaining single-digit maxima are first requests on a fresh isolate.

**Audits stay over 10 ms (K-320).** CPU grows with the upload (parse, sha256 and ranking of every claim: about
5–25 µs per claim on workerd, where this rarely run code stays in V8's lower tiers) and a cold isolate adds
10–25 ms, so even a 60-claim audit can take 27–32 ms. No claim cap would keep every audit under 10 ms, so the
5,000-claim / 5 MiB contract stays: across ~600 measured audits up to 629 ms CPU, Cloudflare never answered
1102 (every outcome `ok`), and audits are rare and rate-limited (K-316). The real fix is Workers Paid
(30 s CPU), which is the owner's decision.

**Audits, second pass (K-351 to K-353).** Validation and ranking now do less per claim, and `rank.bin` (version 2)
is read through core's `columnarFieldIndex`, so a cold isolate maps the buffer instead of building 5,000 field
objects. Same rankings bit for bit. Preview `optimize`, fixture run, CPU p50 / p95 (ms), before → after:

| POST /api/audit | before | after |
|---|---:|---:|
| 60 claims | 6 / 15 | 5 / 12 |
| 500 claims | 11 / 21 | 11 / 14 |
| 2,000 claims | 27 / 55 | 26 / 35 |
| 5,000 claims | 57 / 88 | 43 / 60 |
| 5 MiB of polygons | 89 / 134 | 44 / 53 |

Parsing the upload (JSON.parse) is now the largest single cost of a big audit, so K-320 still holds.

**Headroom.** Memory per isolate at the 5,000-field cap with 20 passes (`make_rehearsal.py --cap 5000 --series
both`): the decoded ranking input 6.2 MB, 17 MB with every field geometry built, 41 MB with the `/tiles` byte cache
full (24 MB budget) — of 128 MB. Assets per deployment: x01 4,696 files with the app (4,599 field cards, 46 field
pages, the run files), 5,115 for the 5,000-field / 20-pass variant, plus ~40 for a carried previous run — of
20,000. The largest file is fields.geojson (3.8 MB; 25 MiB allowed). `validate.py --recompute` on x01: 6 min 25 s
before the simulation memo, 34 s after.

## Publishing the real run

`make publish RUN_ID=r01 ARGS=--dry-run` prints a preflight of the run directory (present, missing with its
owner, optional, made by publish) and the steps. Today `artifacts/r01` has only the geo files; it is waiting on
the pipeline's `passes.json`, `observations.jsonl`, `provenance.json` and `overlays/index.json`, and
`detectability.param_sources.drained_fraction_of_cycle` still needs a citation before `validate.py` accepts a
real run.
