# Security

Mudskipper is a public, read-mostly site: NISAR radar evidence for rice fields in Punjab, served from
Cloudflare Pages at <https://mudskipper-nisar.pages.dev>, with a teammate's copy of the frontend on Vercel at
<https://mudskipper-navy.vercel.app>. There are no accounts, no cookies and no personal data. This page is
the threat model, the attack surface, and the results of the November 2026 audit (DECISIONS.md K-340 to K-349).

## Reporting a vulnerability

Please report privately through GitHub's form:
<https://github.com/volkthienpreecha/Mudskipper/security/advisories/new>. If that form is unavailable, open a
GitHub issue that says only that you have a security report and how we can reach you, without the details.
The same contact is published at [`/.well-known/security.txt`](https://mudskipper-nisar.pages.dev/.well-known/security.txt)
(RFC 9116). We aim to acknowledge reports within a few days. Please do not run load tests or denial-of-service
tests against the deployment: it runs on Cloudflare's free plan.

## Threat model

**What we protect.**

1. **The integrity of the published evidence.** Visitors and inspectors must be able to trust that the
   numbers and maps come from the run we published (run files are content-addressed in `manifest.json` and
   `provenance.json`).
2. **Visitors' browsers.** Nothing an outsider can put in a URL, an upload or a stored audit may run script
   on our origin (DOM XSS, stored XSS, clickjacking).
3. **The free-plan quotas.** KV allows 1,000 writes a day and each Function call has a CPU budget; one client
   must not be able to spend them for everyone.
4. **The deploy credentials.** The Cloudflare API token in CI and the maintainers' `wrangler` logins can
   replace production.

**Who we defend against.** Anonymous internet clients (any request, any header, any body up to the limits),
malicious web pages that a visitor opens in another tab, and a tampered download or run folder on a
teammate's laptop. We trust the three maintainers, GitHub, Cloudflare, Vercel, npm and PyPI.

**Out of scope.** Volumetric DDoS (Cloudflare's job), the Earthdata, ASF and Esri services we read from, and
the maintainers' own machines.

## Attack surface

| Surface | Where | Untrusted input |
|---|---|---|
| `GET /api/*` | `platform/src/app.ts` (Hono 4.13.18 on Pages Functions) | path, query (`tile`, `verdict`, `page`), `If-None-Match` |
| `POST /api/audit` | `platform/src/audit/*`, `core/src/rank.ts` | the whole body: GeoJSON claims up to 5 MiB and 5,000 claims; `cf-connecting-ip` |
| `GET /api/audit/:id` | `platform/src/audit/store.ts` (KV `mudskipper-audits`, 30-day TTL) | the id (must match `^a_[0-9a-f]{16}$`) |
| `GET /tiles/*` | `platform/src/tiles.ts`, `platform/src/http/range.ts` | the key (decoded, traversal-checked, manifest-listed), `Range`, `If-Range`, `If-Match`, `If-Unmodified-Since` |
| Static site | `platform/scripts/build-site.ts` writes `_headers`, `_routes.json`, CSP, `security.txt` | URL paths (SPA fallback), query string read by the app |
| The app | `app/src/*.ts`, `app/src/redesign.js` | URL parameters (`dataset`, `tile`, `field`, `pass`), API responses rendered with `innerHTML` |
| API client | `core/src/client.ts` | API responses, including the `meta.assets` URLs it fetches next |
| Validator | `contracts/validate.py`, `contracts/rules.py` | run folders (JSON, JSONL, GeoJSON) from teammates |
| Data scripts | `geo/*.py`, `pipeline/*.py`, `platform/scripts/run_transfer.py` | downloads (go-pmtiles, Protomaps, GlobalRice, NISAR granules), shared zip files |
| CI | `.github/workflows/*.yml` | pull requests (code from forks), npm and PyPI packages |

## Controls already in place before the audit

- Every Function response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy`, a
  `default-src 'none'; frame-ancestors 'none'` CSP and a JSON error body that never quotes the upload.
- Uploads are capped while streaming (413 before buffering more than 5 MiB, also on a false
  `Content-Length`), parsed as strict UTF-8 JSON, schema-checked with no dependencies (claim ids match
  `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, so stored results cannot carry markup), and rate limited per client
  with a shared daily store budget (K-316).
- Only the ranking result is stored, never the uploaded geometry.
- `/tiles/*` refuses empty, `.`, `..`, backslash and undecodable segments, serves only files the run manifest
  lists, and looks keys up with `Object.hasOwn` (no prototype keys).
- Range handling follows RFC 9110 exactly (tested for open, suffix, oversized, multi-range, reversed and
  non-byte units).
- The app escapes every API value it puts in `innerHTML` and only links `http(s)` URLs.
- CI workflows are pinned to commit SHAs, run with `permissions: contents: read`, never use
  `pull_request_target`, and never interpolate `github.event` fields into shell.
- `run_transfer.py fetch` refuses absolute and `..` paths in a zip and verifies every file's SHA-256.

## Findings

Severity is CVSS-style (low, medium, high) for this deployment: public data, no accounts, free plan.
"Tested" names the regression test or the live check that proves the fix.

| # | Finding | Severity | Status | How it was tested |
|---|---|---|---|---|
| S1 | No `Strict-Transport-Security` on any Pages response (static or Function). `.dev` is HSTS-preloaded in browsers, so the practical risk is small, but other clients and the branch previews had no policy. | Low | **Fixed** (K-341): `max-age=31536000; includeSubDomains` on static assets and every API and tile response. No `preload`: a `pages.dev` subdomain cannot be submitted. | `platform/test/workers/routes.test.ts` "every response carries the security headers" (now also 405, 416, traversal 404, preflight); `platform/test/node/site.test.ts`; live on the `security` preview. |
| S2 | The Vercel copy sent no CSP, no `X-Frame-Options`/`frame-ancestors` (clickjackable), no COOP and no Permissions-Policy. | Medium | **Fixed** (K-342): `vercel.json` sends the same CSP, framing denial, COOP and Permissions-Policy as Pages; routing unchanged; Vercel's own HSTS (two years, preload) is kept. Takes effect on the next Vercel deploy from `main`. | `site.test.ts` "vercel.json … sends the same document security headers" (CSP must equal `APP_CSP`) and "keeps its routing". |
| S3 | Rate limit keyed by the full client address: one IPv6 host can rotate through the 2^64 addresses of its /64 and get a fresh bucket each time, spending the KV write budget and CPU. | Medium | **Fixed** (K-343): `clientKey()` keys IPv6 by /64, IPv4-mapped IPv6 by the IPv4 address. | `platform/test/workers/audit.test.ts` "one IPv6 host cannot dodge the limit…" and "clientKey: …". |
| S4 | API and tile responses had no `X-Frame-Options` (only CSP `frame-ancestors`, which old browsers ignore). | Low | **Fixed** (K-341). | `routes.test.ts`. |
| S5 | Static `Permissions-Policy` covered five features only; no CORP on static assets; the app CSP let `blob:` documents be framed through the `child-src` fallback. | Low | **Fixed** (K-341): fourteen features off, `Cross-Origin-Resource-Policy: same-site` (detached on the public `/data` bundle), `frame-src 'none'` (workers still come from `blob:` per K-319). | `site.test.ts` "_headers adds HSTS, CORP…"; browser check of the preview (no CSP violations). |
| S6 | No published security contact. | Low | **Fixed** (K-349): RFC 9116 `/.well-known/security.txt` from `build-site.ts` (Contact, Expires under a year, Policy, Canonical), renewed on every deploy; this page. | `site.test.ts` "publishes an RFC 9116 security.txt…"; fetched live from the preview. |
| S7 | The API client fetched `meta.assets` URLs relative to its base, so a protocol-relative (`//host/x`) or absolute value would have sent the app to another origin. The server never sends one (schema `^/tiles/\S+$`); defence in depth. | Low | **Fixed** (K-344): `checkAssetPath()` enforces the contract and refuses traversal and encoded separators. | `core/test/client.test.ts` "refuses meta.assets URLs outside /tiles/…". |
| S8 | `contracts/validate.py` read and hashed `provenance.json` artifact paths as given; the schema pattern admits `..`, so a crafted run folder could probe files outside it. Deeply nested JSON crashed the validator with `RecursionError`. | Low | **Fixed** (K-345). | `contracts/tests/test_validate.py` `test_provenance_artifact_path_cannot_leave_the_run`, `test_deeply_nested_json_is_an_error_not_a_crash`. |
| S9 | `geo/basemap.py` downloaded the go-pmtiles release over HTTPS and executed it without checking a digest. | Low | **Fixed** (K-346): SHA-256 pinned per platform from GitHub's release metadata, checked before unpacking. | `geo/tests/test_basemap.py`. |
| S10 | CI checkouts persisted the job token in `.git/config` for every later step, including the deploy job's npm scripts. | Low | **Fixed** (K-347): `persist-credentials: false` everywhere; `zizmor` reports nothing above informational. | `uvx zizmor --offline .github/workflows`. |
| S11 | `?tile=constructor` (any `Object.prototype` name) passed the app's tile lookup and crashed the map; numeric API values were interpolated into markup without coercion. Not script execution. | Low | **Fixed** (surgical edits in `app/src/redesign.js` and `app/src/backend.ts`). | Browser check of `/?dataset=snapshot&tile=constructor` on the preview; app tests. |
| S12 | Optional geo extra `ftw` locks `torch 2.10.0`, `lightning 2.5.4` and `fsspec 2025.7.0`, which have advisories (unsafe checkpoint deserialisation, Jinja templating of Kerchunk references). | Medium (local only) | **Accepted** (K-348): `ftw-tools==2.0.0b5` caps `lightning<2.6` and `fsspec<2026`, so no patch or minor upgrade resolves; the extra is never installed in CI or deployed, and only loads the official FTW checkpoint. Revisit when ftw-tools releases. | `uvx pip-audit` on `uv export --all-extras`; base geo and contracts environments: no known vulnerabilities. |
| S13 | `style-src 'unsafe-inline'` in the app CSP. | Low | **Accepted** (K-348): the built page has an inline `<style>` and the app sets `style=""` attributes; scripts stay `'self'` only, so injected CSS cannot run code, and every interpolated value is escaped. | Header tests; preview browser check. |
| S14 | A path under `/assets/` that does not exist returns the SPA page with the `/assets/*` one-year immutable cache. | Low | **Accepted** (K-348): asset names are content hashes nobody can predict, so only URLs that never existed are affected; fixing it needs a Function on every asset request. | Live: `curl -I /assets/nonexistent.js`. |
| S15 | The rate limiter is per isolate (per data centre) and the store budget is approximate; many clients from many addresses (or a page that makes visitors' browsers post) can still spend the daily store budget. | Low | **Accepted** (K-316, K-348): over budget the API ranks without storing (200, `x-audit-stored: false`), so nothing breaks; the Workers Rate Limiting binding is not available to Pages. | Existing budget tests in `audit.test.ts`. |
| S16 | `POST /api/audit` accepts `text/plain` bodies (a CORS simple request, no preflight). | Info | **Accepted**: the endpoint is anonymous and `Access-Control-Allow-Origin: *` already lets any origin post JSON; there is no session to forge. | Live probe: 400 for a wrong shape, as expected. |
| S17 | Stored audits are readable by anyone who has the id. | Info | **Accepted** (contract B6): ids are 64-bit content hashes, results hold only ranks, field ids and the uploader's claim ids, never geometry. | — |

**Clean areas.** `npm audit` (all workspaces): 0 vulnerabilities; every npm dependency is on its latest
patch and minor (only `@types/node` 26 is newer, a deliberate major pin to Node 24). `pip-audit` on
`contracts/requirements.txt` and the base geo lock: no known vulnerabilities. `gitleaks` over all 126 commits:
one hit, a false positive (generated validator key names in `platform/test/gen/validators.js`); targeted
history greps for Cloudflare, GitHub, AWS and Earthdata credentials and for `.env` files found nothing.
`.gitignore` covers `.env`, `.env.*` and `.dev.vars`.

**Live tests** (non-destructive, a handful of requests, against production and the `security` preview): traversal through
`..`, `%2e%2e`, `%252e`, `%5c`, `__proto__` and `constructor` on `/tiles` all return 404 JSON or a
Cloudflare 400; `/api/fields/<script>` and `?tile=<img>` return escaped JSON errors with nosniff and
`default-src 'none'`; every Range edge case (`bytes=-0`, oversized, reversed, multi-range, `items=`, hex,
exponents, 23-digit numbers) answers per RFC 9110; `PUT`, `DELETE`, `PATCH` give 405 with `Allow`, `TRACE` and
`CONNECT` are stopped by Cloudflare; a 6 MiB audit is 413 before the body is read, malformed JSON is 400; no
response reflects `X-Forwarded-Host`; no stack traces or internal paths in any error.

**Cache and `Vary`.** Pages does not cache Function responses at the edge, and every API response is the same
for every `Origin` (`Access-Control-Allow-Origin: *`), so no `Vary` is needed today. A route that negotiates on
`Accept` (for example Markdown versions of pages) must send `Vary: Accept`, or browsers and proxies may serve
one format for the other.

## Headers, as deployed

| Header | Static (`_headers`) | API and tiles (Functions) | Vercel (`vercel.json`) |
|---|---|---|---|
| Content-Security-Policy | app: `script-src 'self'`, `worker-src 'self' blob:`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`; placeholder: hash-pinned | `default-src 'none'; frame-ancestors 'none'` | same as the app on Pages |
| Strict-Transport-Security | `max-age=31536000; includeSubDomains` | same | Vercel default (`max-age=63072000; includeSubDomains; preload`) |
| X-Frame-Options | `DENY` | `DENY` | `DENY` |
| X-Content-Type-Options | `nosniff` | `nosniff` | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` | same | same |
| Permissions-Policy | 14 features off | n/a (JSON) | same as static |
| Cross-Origin-Opener-Policy | `same-origin` | n/a (JSON) | `same-origin` |
| Cross-Origin-Resource-Policy | `same-site`; none on `/data/*` | `cross-origin` (public data) | — |
| Access-Control-Allow-Origin | `*` (Pages default; public files, no credentials) | `*`, never with credentials | proxied from Pages |

## Needs a repository admin

These are settings, not code, so this audit only reports them:

1. **Turn on private vulnerability reporting** (Settings → Code security). The advisory form that
   `security.txt` and this page point to only works once it is on.
2. **Protect `main`**: require pull requests, the five CI checks and one review; block force pushes.
3. **Add a `production` environment** with required reviewers and move `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` into it, then add `environment: production` to the `deploy` job. Today any workflow
   change merged to `main` can read the token.
4. **Scope the Cloudflare API token** to "Cloudflare Pages: Edit" on this one account (and KV write if CI ever
   needs it), with an expiry.
5. **Enable secret scanning and push protection**, and **Dependabot alerts** (plus Dependabot version updates
   for `github-actions`, `npm` and `uv`, so the pinned SHAs stay current).
