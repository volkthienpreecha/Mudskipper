# Decisions

One line of context per decision, newest at the bottom of each section. Contract changes are additive only
(SPEC A10): add a line here, update `contracts/`, and tell the team. Dates are 2026, times UTC.

## Lane 0 seed (Karthik, Nov 14)

| # | Decision | Why |
|---|---|---|
| D-001 | **Study area:** Fazilka + Sri Muktsar Sahib, Punjab, Kharif 2026; two ~15 × 15 km tiles, one per district, one NISAR frame and one orbit direction; cap 5,000 fields. Fallbacks in order: Sangrur/Bathinda → Karnal → Telangana → Arkansas/Sacramento. | SPEC A2: largest 2026 DSR districts (Fazilka 1,55,422.77 acres, 12,063 farmers; Sri Muktsar Sahib 1,06,038.81 acres, 7,345 farmers; Ferozepur 38,088.59 acres, 1,929 farmers; [DT Next/PTI, 19 Jul 2026](https://www.dtnext.in/news/business/punjab-dsr-area-rises-36-to-over-4-lakh-acres-in-kharif-2026-minister)). |
| D-002 | **Fixture tiles:** `fazilka` centred 74.12°E 30.33°N and `muktsar` centred 74.45°E 30.40°N (bboxes in `.env.example`). Real tiles are chosen by `geo/grid.py` (H+0:45). | Both centres are covered by descending track 135 frame 73 and ascending track 84 frame 17 in ASF's catalogue, so one frame and one direction is possible. |
| D-003 | **Coverage result: preliminary, Ishaan to confirm with the A6 check on the real tiles.** An ASF Search API point query at both tile centres (Jun 17 – Oct 23, GCOV, CRID P05023) returns: ascending track 84 frame 17, 10 passes, all `DHDH` (Jun 20 … Oct 18, 12-day cadence, Aug 7 lost to the gap); descending track 135 frame 73, 10 passes, 6 `DHDH` (Jun 23, Jul 5, Jul 17, Aug 10, Oct 9, Oct 21) and 4 `QPDH` quad-pol (Aug 22, Sep 3, Sep 15, Sep 27). **Quad-pol has fewer than 6 passes, so per A6 the full season runs on HH/HV (`hhhv_v1`), with Freeman–Durden available on 4 mid/late descending passes.** | Saves Ishaan an hour tonight and settles the cut-list question early. Say "HH/HV, with quad-pol on 4 passes" on the page (WIN_GUIDE §10). |
| D-004 | **License: GPL-3.0-only** for the whole repository. | pyNISAR and polsartools are GPL-3.0 (SPEC A10). Third-party notices in `NOTICE`. |
| D-005 | **Evidence rule:** every number carries OBSERVED, INFERRED or ASSUMED; the tag per field is fixed in `contracts/evidence_tags.json`. | SPEC evidence rule, T12. One table instead of per-screen judgement calls. |
| D-006 | **Processing offline, serving on Cloudflare.** Python runs on our laptops and writes `artifacts/<run_id>/`; `make publish` loads R2 + D1; one Worker serves the app and the API. | NISAR subsets are large and slow to fetch; judges only ever touch Cloudflare. |
| D-007 | **One implementation of the rules (SPEC A4):** simulation, verdicts, ranking and story live in `core/` (TypeScript). `contracts/rules.py` is a stdlib Python *reference* used only to make self-consistent fixtures and to validate any run; core's tests must reproduce `contracts/fixtures/` bit for bit (same PRNG, same arithmetic order, same strings). | Fixtures must obey B3.5 before core exists; the bit-for-bit golden test turns a second copy into a drift detector instead of a liability. |
| D-008 | **Deadline: TODO.** Confirm the closing time in the 2026 Submission Guide and write it here. Submission opens Sat 9:00 local. | WIN_GUIDE §12. |
| D-009 | **Owners:** Volk `app/`; Karthik `platform/`, `core/`, `geo/`; Ishaan `pipeline/`. `contracts/` is shared and reviewed by all three (`.github/CODEOWNERS`). | SPEC A4. |
| D-010 | **Repo:** `github.com/volkthienpreecha/Mudskipper` (created by Volk). It is **private**; it must be made public before submission (Volk is the admin). | SPEC A6 asks for a public repo; WIN_GUIDE §13 checklist. |
| D-011 | **Git workflow:** Karthik's lanes land through short PRs merged with merge commits, after CI is green; teammates may commit straight to `main` (A10). Everyone runs `git pull --rebase` before pushing; nobody force-pushes. | Keeps contract changes reviewable without slowing the other lanes. |
| D-012 | **Fixtures keep the SPEC B9 mode mix** (9 QP + 3 DH, 10 used) on the real descending cadence, although the real series is mostly DH (D-003). | Both classification methods and both code paths stay exercised; fixtures are SAMPLE either way. |

## Contract v1 clarifications (Karthik, Nov 14)

Each fills a gap SPEC Part B leaves open; details are in `contracts/CONTRACTS.md`.

| # | Clarification |
|---|---|
| C-001 | Every JSONL **line** carries `v` and `run_id`; every API response carries `fixture` as a boolean (T8). |
| C-002 | Id formats: `field_id` = `<tile>-<5 digits>`; `pass_id` = `YYYYMMDD-T<track><A|D>`, plus a short suffix for an excluded duplicate product (ASF lists PR and UR products of the same acquisition). |
| C-003 | Fixture granule ids start with `SAMPLE_`; real ones must match the official 18-field NISAR GCOV name. The validator enforces both (T3). |
| C-004 | `aoi.json` adds `stages` (`mid_start`, `late_start`); `fields.geojson` adds a label point `lon`/`lat` per field. |
| C-005 | `observations`: `confidence = |2·p_flooded − 1|`; observed values may be `null` only when `valid_frac` is 0; a DH pass must use `hhhv_v1`. |
| C-006 | Verdict rule: `consistent` if drained hits ≥ k\*; `not consistent` if zero drained hits and P(an AWD field shows ≥ 1 drained look) ≥ 0.90; otherwise `not enough evidence`. k\* = smallest k with continuous-flooding false flags ≤ 10%. Both 10% thresholds live in `detectability.params`. |
| C-007 | AWD window: from the first flooded early-season clear look + 14 days (`inferred`), else the midpoint of the transplant window (`assumed`), to + 85 days. |
| C-008 | DSR signal: `unknown` with fewer than 2 early clear looks; `transplant_signal` if any is flooded; otherwise `dsr_signal`. |
| C-009 | Simulation: mulberry32 + FNV-1a seed derivation, five draws per run plus one per look, written so Python and TypeScript agree to the bit. `per_pass_accuracy` is per stage; results add the full distribution `dist` for the Lab charts. |
| C-010 | Ranking: claims match by `field_id` hint, then point-in-polygon; claims on one field merge; DSR claims weigh by DSR signal (transplant 1.0, unknown 0.6, DSR 0.1) on the same scale as AWD; random picks = floor((n + 2) / 5); `audit_id` and the default seed come from the request hash, so the same upload gives the same ranking (T7). |
| C-011 | `overlays/index.json` is an object (`{v, run_id, overlays: [...]}`) so it can carry the header. |
| C-012 | `/api/checks` also returns the district table; `/api/meta` adds asset URLs and the Limits text. |
| C-013 | `param_sources` entries carry a status (`cited`, `derived`, `convention`, `needs_citation`); a real run with `needs_citation` fails validation. |
| C-014 | After an independent review: `cf_false_flag_max` and `awd_miss_max` are fixed at 0.1; the season sentence states the count for any k\*; reason percents compared with a threshold round down; duplicate `claim_id` → 400, missing → `#<n>`; concave claims get an interior point; open rings → 400; uploads may carry extra GeoJSON members, properties and altitude; no `NaN`/`Infinity` anywhere; provenance lists every pass (T3); every cross-language detail (integer remainders, one-division probabilities, exact ray-casting predicate, code-unit sort order, parsed-value equality) is written into CONTRACTS.md. |

## Lane Karthik (Karthik, Nov 15)

| # | Decision | Why |
|---|---|---|
| K-001 | **`states.json` + `GET /api/states` (contract addition, B3.13):** every field's state on every used pass as one compact string per field. | The map's season animation needs per-pass colors for all fields; B6 had no endpoint for it. |
| K-002 | **Hosting: Cloudflare Pages project `mudskipper-nisar` → `https://mudskipper-nisar.pages.dev`**, with the same Hono app running as Pages Functions on `/api/*` and `/tiles/*` (Pages' `_routes.json` is the equivalent of `run_worker_first`). | The account's workers.dev subdomain is autogenerated (`karthik-e5e`), which our URL rule forbids; `mudskipper.pages.dev` belongs to someone else. |
| K-003 | **Storage backends:** the platform reads through one repository interface with two implementations: D1 + R2 exactly as SPEC B4/B5, and a static backend (the publish script writes every API response as JSON into the deployment; audits go to KV). Production uses the static backend until D1 and R2 are available on the account. | The Cloudflare account is at the free plan's 10-database D1 limit and has R2 disabled; both need the owner's decision (free a database slot or upgrade; enable R2). Same responses, same tests, switch by config. |
| K-004 | **npm workspaces** (`core`, `platform`; `app` joins when Volk adds `app/package.json`), Node ≥ 24.12, TypeScript 7.0.2, Vitest 5.1, Hono 4.13.18, Wrangler 4.162.0; core is consumed as TypeScript source with no build step. | Verified by the research prototype: Vite, Wrangler and plain `node` all run core's `.ts` directly. |
| K-301 | **Pages Functions layout:** one Hono app (`platform/src/app.ts`) mounted by `functions/api/[[path]].ts` and `functions/tiles/[[path]].ts`; `_routes.json` is written explicitly as `/api`, `/api/*`, `/tiles/*` (a wildcard alone misses `/api`); no top-level 404.html so unknown paths get the SPA fallback. | Pages' equivalent of SPEC B7 `run_worker_first`; static paths never invoke a Function. |
| K-302 | **Static backend layout:** `/data/live.json` + `/data/runs/<run_id>/{manifest.json, api/<doc>.json, api/fields.json, api/fields/<id>.json, api/summaries.json, <run files>}`, built by the same response builder as the D1 loader; the manifest (sizes, sha256, docs present) is read first so the SPA fallback page is never mistaken for data. | Mirrors R2's B5 keys, so `/tiles/<key>` maps to R2 `<key>` or asset `/data/<key>` unchanged. |
| K-303 | **Pages static assets ignore `Range`** (checked on the live site: 200 with the whole file), so `/tiles/*` computes ranges itself (206/416/304/If-Range) from the manifest; with R2 it uses `head()` + a ranged `get()` through the same code. | PMTiles needs exact byte ranges; both backends must answer identically. |
| K-304 | **D1 schema deviations (additive):** `run_id` in every primary key; all tables `WITHOUT ROWID` + `STRICT`, no secondary indexes; added columns `fields.geometry`, `passes.{track,frame,covariance_terms,pixel_m,valid_fraction_by_tile,excluded_reason}`, `observations.{vv_db,hh_hv_db,observed_keys,n_px,method,flags}`, `summaries.{k_star,window_start,window_end,window_source}`, `audits.run_id`; added table `docs` (run-level responses + manifest as JSON); `meta.live` mirrors live.json. | One row written per changed row (free plan: 100k/day); exact round trip of every response. |
| K-305 | **D1 loader:** diff against the database, then guarded multi-row upserts (≤ 100 bound params, `WHERE <a column differs>`), via wrangler's platform proxy (local or remote bindings); remote loads over 90,000 expected rows are refused without `--allow-over-budget`. Fixture run measured: 3,620 expected = 3,620 written, second load 0. | Idempotent publishes inside the daily write cap. |
| K-306 | **Audits:** stored in D1 `audits` when DB is bound, else KV namespace `mudskipper-audits` (key `audit:<audit_id>`); only the ranking is stored, never the upload; a repeated body returns the stored result without re-ranking. `POST` answers 201 + `Location`, or 200 if already stored. | Content-addressed ids (B6 step 8) make audits immutable and cacheable for a year. |
| K-307 | **Request validation in workerd:** Ajv standalone code generated from `contracts/schemas` (`platform/src/gen/audit-request.js`, drift-checked in CI), with Ajv's two runtime helpers inlined. Order: 413 → invalid_json → too_many_claims (400) → invalid_request → invalid_geometry → duplicate_claim_id (rules.py's order). | workerd forbids `new Function`, so schemas cannot compile at runtime. |
| K-308 | **Cache policy:** live-scoped API `max-age=60, swr=600` + ETag from the bundle hash; stored audits and real-run `/tiles` immutable for a year; the fixture run 5 min; `live.json` no-cache. `publish.ts` refuses to re-publish a real `run_id` with different bytes unless `--allow-republish`. | Run ids are immutable once live; the fixture run is regenerated in place. |
| K-309 | **Placeholder site** until `app/dist` exists: SPEC Part D palette and fonts (self-hosted woff2), the live headline, a season strip drawn from `states.json`, the endpoint list and the Limits box; hash-pinned CSP; OG image rendered by headless Chrome from the same fonts (`npm run og`). CI's main-branch deploy ships only the fixture site and skips when production serves a real run. | A judge opening the link before the app lands still sees a finished page and a working API. |

## Parameters and citations (for Ishaan's review, SPEC A4)

| Param | Value | Status | Source |
|---|---|---|---|
| `transplant_window` | Jun 5 – Jul 15 | cited | Zone 3 (incl. both districts) opens Jun 5 ([Babushahi, 29 Apr 2026](https://babushahi.com/full-news.php?id=220401)); PAU: PR 126 transplanted by Jul 15 ([PAU PoP Kharif 2026](https://pau.edu/content/ccil/pf/pp_kharif.pdf)) |
| `awd_window_days_after_transplant` | 14 – 85 | derived | IRRI: AWD starts 1–2 weeks after transplanting ([IRRI](http://www.knowledgebank.irri.org/step-by-step-production/growth/water-management/alternate-wetting-drying-awd)); PAU: stop irrigating ~2 weeks before maturity, PR 126 at ~93 days, PR 130–133 at 105–111 |
| `cycle_days` | 4 – 10 | cited | Shah et al., AAAI 2026 ([arXiv 2507.08605](https://arxiv.org/abs/2507.08605)) |
| `drained_fraction_of_cycle` | 0.3 – 0.5 | **needs_citation** | No source states it. PAU's "irrigate 2 days after ponded water infiltrates" implies ~2 dry days per 4–10 day cycle, i.e. 0.2–0.5. **Ishaan: pick 0.2–0.5 (derived) or find a source before the real run.** |
| `cf_single_drain_prob` | 0.51 | derived | India BUR-3 via [CEEW Table 1](https://www.ceew.in/sites/default/files/what-reduces-emissions-in-sustainable-rice-cultivation.pdf): single aeration 16.44% vs continuous 15.89% of rice area. National, not Punjab. |
| `per_pass_accuracy` | 0.94 / 0.80 / 0.80 | cited | Islam et al. 2026, [Remote Sensing 18:1183](https://doi.org/10.3390/rs18081183): ALOS-2 full-pol, Bangladesh. Dual-pol is expected to do worse ([Jin et al. 2026](https://doi.org/10.3390/rs18132136)). |

## Flags for the team

| # | Flag |
|---|---|
| F-001 | **WIN_GUIDE §8 "1.5M rice credits committed in 2026"** is really two offtake agreements signed in 2026 for delivery by 2030: Google 1M ([PR Newswire, 10 Sep](https://www.prnewswire.com/news-releases/google--mitti-labs-partner-to-eliminate-methane-and-scale-climate-smart-ag-practices-across-indias-rice-fields-302873982.html)) and Salesforce 500k ([PR Newswire, 28 Oct](https://www.prnewswire.com/news-releases/mitti-labs--salesforce-partner-to-scale-water-saving-rice-farming-practices-that-reduce-methane-emissions-302919088.html)). Suggested wording: "1.5M rice methane credits contracted in 2026 for delivery by 2030". |
| F-002 | The SPEC A6 snippet keys passes by track, direction, frame, polarization and CRID only. Over Punjab, ASF also returns UR (Urgent Response) products and mixed-mode/partial-frame splits for the same acquisition. Filter `t[2] == "PR"` and dedupe by acquisition (CONTRACTS.md B3.2). |
| F-003 | OPERA DSWx-NI has no official collection yet (test granules are v0.4); the ≥3 ha / 200 m width requirement comes from the 2025 OPERA workshop slides. Fall back to DSWx-S1 if NI is not retrievable (SPEC Lane Ishaan step 7). |
| F-004 | Islam et al. 2026 studied Bangladesh, not India; cite it as "L-band full-pol in South Asia". |
| F-005 | Han et al. 2022 rice map (APRA500) is 500 m and covers 2000–2021 (CC-BY-4.0 on Zenodo); as a rice mask for 1–5 ha fields it is coarse. Note this in Methods if it is used. |
| F-006 | FTW's default model `FTW_PRUE_EFNET_B5` has mixed weight licenses that include non-commercial data; the `*_CCBY` v3.1 variants are CC-BY-4.0. Prefer a CCBY variant (Lane Karthik step 3). |
| F-007 | **Cloudflare free plan: D1 allows 100,000 rows written per day, and each index adds a write per row.** Loading ~55k rows naively can hit the cap; the publish script must use a guarded upsert (`ON CONFLICT … DO UPDATE … WHERE changed`) and few indexes (Lane Karthik plan). |
