# MUDSKIPPER — BUILD SPEC v3

NASA Space Apps 2026 · "Dancing with the SARs" · Deployed fully on Cloudflare

> Transcribed from the team's *Mudskipper (NASA) Specs* document (v3, 2026-11-14). It is kept word for word,
> except that layout artifacts from the PDF (repeated lines, wrapped code) have been cleaned up.
> Each LANE block in Part C is a Claude Code kickoff prompt. The companion document is
> [`WIN_GUIDE.md`](WIN_GUIDE.md). The normative data contracts are in
> [`../contracts/CONTRACTS.md`](../contracts/CONTRACTS.md). Where that file adds detail Part B leaves open,
> CONTRACTS.md wins, and each such addition is logged in [`../DECISIONS.md`](../DECISIONS.md).

**Team assignments:** Volk: `app/` · Karthik: `platform/`, `core/`, `geo/` · Ishaan: `pipeline/`

**EVIDENCE RULE** (UI, API, README, video): every number carries one tag.

- **OBSERVED** = radar measurement
- **INFERRED** = our model's reading
- **ASSUMED** = cited parameter

---

## PART A — THE BUILD

### A1. Product

For rice fields in Punjab (Kharif 2026): label each field flooded / drained / uncertain on every NISAR pass;
give a season verdict for AWD and a DSR signal; simulate what the real pass dates can detect; rank fields for
inspection. A phone-first site with an auto tour, built so the project page and the 30-second video are
generated from it.

### A2. Study area

Primary: Fazilka + Sri Muktsar Sahib (largest 2026 DSR districts: 155,423 and 106,039 acres; Ferozepur
38,089). Two tiles of about 15 × 15 km, one per district, inside ONE NISAR frame and ONE orbit direction.
Cap 5,000 fields.

Fallback order: Sangrur/Bathinda → Karnal (Haryana) → Telangana → Arkansas or Sacramento Valley rice. Record
the choice in DECISIONS.md.

### A3. Golden path (must work on the deployed URL, on a phone)

1. `/` Story: the question, the map already animating, one plain number, two buttons.
2. Tour (`?tour=1`): unattended 45 s: Map → Field card → Lab → Scarecrow.
3. Map: pass slider, data-gap band, fields colored by state or verdict.
4. Field card: pass chips, component sparkline, verdict + reason, evidence tags.
5. Detectability Lab: sliders, two charts, one live sentence.
6. Scarecrow: sample program (SYNTHETIC) or GeoJSON upload → ranked list.
7. Evidence: district table, season shape, OPERA cross-check, provenance, Limits box.
   `/judges`: criterion → evidence table with deep links.

### A4. Lanes and the one design decision

| Person  | Directories               | Work |
|---------|---------------------------|------|
| Ishaan  | `pipeline/`               | NISAR search + AOI reads, decomposition, per-field stats, flooded/drained states, overlays, provenance, season-shape and OPERA checks |
| Karthik | `platform/` `core/` `geo/` | Lane 0 bootstrap; Cloudflare Worker, D1, R2, CI; core TypeScript package (simulation, verdicts, ranking, typed API client); field polygons; district table; sample claims; publish script |
| Volk    | `app/`                    | Site, tour, record mode, capture script, page copy, video |

**DECISION:** simulation, verdict logic and ranking exist ONCE, in `core/` (TypeScript). The publish script
runs them in Node to write detectability and field summaries; the Worker runs ranking for uploads; the app
runs the simulation live for the sliders. Ishaan reviews the parameters and the verdict rule but does not
reimplement them.

### A5. Timeline (H = hours after start)

| When     | Who     | Gate | If it fails |
|----------|---------|------|-------------|
| H+0:20   | Karthik | Lane 0 pushed, tagged `v0-foundation` | Volk reruns it |
| H+0:45   | Karthik | geo: labeled 40 m grid for both real tiles | fixture bbox |
| H+1      | Karthik | Worker live, serves fixtures at `/api/*` | fix by H+3 |
| H+2      | Ishaan  | Coverage decided (QP or DH); 1 pass processed | dual-pol path |
| H+3      | Karthik | FTW field polygons replace the grid | keep labeled grid |
| H+3      | Ishaan  | First real `observations.jsonl` (any 1 pass) | pair with Karthik |
| H+4      | Volk    | Story + Map + tour on fixtures, deployed | stay on fixtures |
| H+5      | Karthik | core: sim + verdicts + ranking + API client tested | ship sim first |
| H+6      | Ishaan  | All passes → `observations.jsonl`, overlays | one tile only |
| H+8      | Karthik | Real run published; `live.json` flipped | serve JSON from R2 |
| H+10     | Volk    | Page draft v1 + hero GIF from capture | - |
| Day 2 AM | Ishaan  | Season-shape + OPERA check; Methods + Limits text | note as not run |
| Day 2 AM | Karthik | District table; README; `/judges` data; OG preview | - |
| Day 2 PM | Volk    | Video via record mode; page images final | 7-slide fallback |
| −3 h     | all     | Freeze. Three clean tours. Submit. Then polish. | - |

### A6. Tonight (Ishaan runs the check; everyone does accounts)

```python
# pip install asf_search ; python check_coverage.py
# VERIFY the dataset name in current asf_search docs if this returns nothing.
import collections, os, asf_search as asf
AOI = "POLYGON((73.9 30.1, 74.7 30.1, 74.7 30.6, 73.9 30.6, 73.9 30.1))"  # Fazilka–Muktsar
res = asf.search(dataset="NISAR", intersectsWith=AOI, start="2026-06-17", end="2026-10-31")
g = collections.defaultdict(list)
for r in res:
    p = r.properties
    n = p.get("fileID") or p.get("fileName") or p.get("sceneName") or os.path.basename(p.get("url", ""))
    if "_GCOV_" not in n:
        continue
    t = n.split("_")  # ..._GCOV_CYL_TRACK_DIR_FRAME_MODE_POL_S_START_END_CRID...
    g[(t[5], t[6], t[7], t[9], t[13] if len(t) > 13 else "?")].append(t[11][:8])
for k, d in sorted(g.items(), key=lambda x: -len(x[1])):
    print("track %s dir %s frame %s pol %s crid %s:" % k, len(d), sorted(set(d)))
print("QUAD-POL FOUND" if any(k[3].startswith("QP") for k in g) else "NO QUAD-POL")
```

Alternative: pyNISAR `find_scenes(product="GCOV", aoi=..., polarization="quad")`.

Decide: QP with ≥6 passes in one direction → proceed. QP with <6 → add the second direction, thresholds per
direction. DH only → try the fallback regions; if none, stay and use method `hhhv_v1` with the dual-pol
caveat. Post the result in the team chat.

- Ishaan: Earthdata login works; start caching AOI subsets on home internet.
- Karthik: `wrangler login`; create D1 "mudskipper" and R2 "mudskipper-data"; create the public repo; install
  the FTW CLI.
- Volk: Node 22, Playwright, ffmpeg installed; fonts downloaded.

All: read the 2026 Judging and Awards Guide and Submission Guide.

### A7. Cut list

In order of priority to cut: impact ranges → ISRO S-band → GeoJSON upload → OPERA check → second tile → field
polygons (keep labeled grid) → quad-pol (use HH/HV).

**NEVER CUT:** real NISAR data, Story + tour, Detectability Lab, evidence tags, Limits box.

### A8. Risks

| Risk | Response |
|------|----------|
| No quad-pol | A6 decision tree; say it on page and site |
| Ishaan is the critical path | Karthik pairs at H+3 if no observations; grid fields at H+0:45 so zonal stats never wait |
| Few passes (gap, stripes) | sim reports it; default `not_enough_evidence` |
| Weak class separation | uncertain is first-class; show the histograms |
| Mixed CRIDs in one series | one CRID per series; else exclude and flag |
| Venue Wi-Fi | AOI subsets cached tonight |
| DSR sown before Jun 17 | dsr signal "unknown"; stated in Limits |
| Looks like an accusation tool | wording rules (D5); synthetic sample claims only |

### A9. Acceptance tests

- **T1:** `make validate` green on fixtures and artifacts.
- **T2:** Pipeline rerun → identical hashes.
- **T3:** Every pass maps to a real granule ID shown in provenance.
- **T4:** One CRID per series.
- **T5:** No observation dated inside `2026-07-27T22:03:25Z..2026-08-10T00:55:27Z`.
- **T6:** core sim is deterministic per seed; verdict logic matches B3.5 on scripted cases.
- **T7:** Ranking: exactly 20% random picks, same output for the same seed.
- **T8:** Fixture responses show the SAMPLE badge.
- **T9:** `/` interactive < 3 s on throttled 4G; screenshots OK at 390×844 and 1920×1080.
- **T10:** Tour and record mode run unattended with identical timing twice.
- **T11:** `npm run capture` outputs `hero.gif` < 10 MB and video ≤ 30.0 s.
- **T12:** No UI number without a source file and an evidence tag.

### A10. Team rules

- Own git identity; no AI co-author lines. Commit only inside your own directories; `git pull --rebase`
  before each push; small commits to main; nobody force-pushes.
- Contract changes: additive only, one line in DECISIONS.md, message the team.
- Read current docs first (Context7 or llms.txt) and follow them over this spec.
- Never fake a number, pass or verdict. Never label a real person.
- Don't stop to ask: decide, log in DECISIONS.md, continue. Stop only for credentials, spending, or
  destructive actions. Two failures → change approach.

License GPL-3.0-only (pyNISAR and polsartools are GPL-3.0). Keep third-party notices.

### A11. Verified facts (Nov 13, 2026; URLs in B8)

- NISAR provisional GCOV: acquisitions 2026-06-17 to about 2026-10-23, CRID P05023. Validated (CRID P05036)
  starts 2026-10-21. Permanent data gap 2026-07-27 to 2026-08-10. 12-day repeat. Off-diagonal covariance
  terms exist only in quad-pol GCOV. Quad-pol images have shifting gap stripes. Pixel spacing 10 or 20 m.
- Prior studies: Islam et al. 2026: full-pol L-band + Freeman–Durden, 704 fields, 94% early / 80% under dense
  canopy. Jin et al. 2026: dual-pol alone unreliable; median drainage 19 h. Shah et al. AAAI 2026:
  Sentinel-1, F1 0.80 DSR / 0.74 AWD; cycles every 4–10 days.
- Punjab Kharif 2026 DSR: 31,478 farmers, 4+ lakh acres, Rs 1,500/acre, ~Rs 61 crore.
- OPERA DSWx-NI: open water + inundated vegetation from NISAR, 30 m, v0.4 test product, designed for water
  bodies ≥3 ha: aggregate comparisons only.

Cloudflare: one Worker serves assets + API; API paths need `run_worker_first`.

---

## PART B — CONTRACTS (copy to `contracts/CONTRACTS.md`, v1)

### B1. Repo structure

`mudskipper/` README.md DECISIONS.md LICENSE NOTICE Makefile .env.example

- `docs/` {SPEC.md, WIN_GUIDE.md, PAGE.md}
- `contracts/` {CONTRACTS.md, schemas/, fixtures/, make_fixtures.py, validate.py}
- `pipeline/` (Ishaan, Python)
- `geo/` (Karthik, Python: fields, district table, sample claims)
- `core/` (Karthik, TypeScript package: sim, verdicts, ranking, API client, types)
- `platform/` (Karthik, Cloudflare Worker + publish script + CI)
- `app/` (Volk, Vite + TypeScript)

`data/` (gitignored) · `artifacts/<run_id>/` (gitignored; published to R2/D1)

### B2. Env (`.env.example`)

```sh
EARTHDATA_USERNAME= EARTHDATA_PASSWORD= RUN_ID=r01
AOI_TILES=fazilka:minLon,minLat,maxLon,maxLat;muktsar:minLon,minLat,maxLon,maxLat
SEASON_START=2026-06-17 SEASON_END=2026-10-23
CLOUDFLARE_ACCOUNT_ID= CLOUDFLARE_API_TOKEN= (CI secrets only)
```

### B3. Artifacts (`artifacts/<run_id>/`; each file has `"v":1,"run_id"`; fixtures add `"fixture":true`)

| File | Written by | Read by |
|------|------------|---------|
| `aoi.json`, `fields.*` | Karthik (geo) | Ishaan, publish, app |
| `passes.json` | Ishaan | core, publish, app |
| `observations.jsonl` | Ishaan | core, publish |
| `overlays/*`, `hist/*` | Ishaan | publish, app |
| `provenance.json` | Ishaan (+ publish) | app |
| `checks.json` | Ishaan | app |
| `detectability.json` | publish (core) | app |
| `field_summary.jsonl` | publish (core) | app |
| `district_check.json` | Karthik (geo) | app |
| `story.json` | publish (core) | app |

#### Artifact details

- **B3.1 `aoi.json`:** `{tiles:[{id,district,bbox}], utm_epsg:32643, season:{start,end}, gaps:[{start,end,source}]}`
- **B3.2 `passes.json`:** `{passes:[{pass_id, granule_id, datetime, direction, track, frame, pol_mode:"QP|DH",
  covariance_terms:[...], crid, maturity, pixel_m, valid_fraction_by_tile:{...}, used:bool, excluded_reason}]}`
- **B3.3 `fields.geojson`** (+ `fields.pmtiles`): properties `{field_id, tile, district, area_ha,
  source:"ftw|manual|grid", rice_mask_frac}`. Min 0.5 ha; `rice_mask_frac` ≥ 0.5.
- **B3.4 `observations.jsonl`** (one line per field per pass): `{field_id, pass_id, n_px, valid_frac,
  observed:{hh_db,hv_db,vv_db?,ps_db?,pd_db?,pv_db?,hh_hv_db}, stage:"early|mid|late",
  inferred:{state:"flooded|drained|uncertain", p_flooded, confidence, method:"fd_gmm_v1|hhhv_v1"}, flags:[...]}`.
  Uncertain if `valid_frac < 0.6` or `0.35 < p_flooded < 0.65`.
- **B3.5 `field_summary.jsonl`:** `{field_id, awd:{window:{start,end,source}, clear_looks, drained_hits,
  p_catch_ge1_if_awd, k_star, verdict:"consistent|inconsistent|not_enough_evidence", reason},
  dsr:{signal:"dsr_signal|transplant_signal|unknown", reason}}`
- **B3.6 `detectability.json`:** `{seed, n_sim, pass_dates, params:{transplant_window,
  awd_window_days_after_transplant:[14,85], cycle_days:[4,10], drained_fraction_of_cycle:[0.3,0.5],
  cf_single_drain_prob, per_pass_accuracy}, param_sources:{...}, results:{awd:{p_ge1,p_ge2,p_ge3},
  cf:{p_ge1_false,p_ge2_false}, k_star, k_star_rule:"smallest k with cf false-flag ≤ 0.10"}, sentence}`
- **B3.7 `district_check.json`:** `{year:2026, rows:[{district, gov_dsr_acres, gov_farmers, tile_rice_ha,
  tile_dsr_signal_ha, tile_dsr_signal_frac}], note, source_urls}`
- **B3.8 `checks.json`:** `{season_shape:{pct_flooded_by_stage, pass}, opera:{product, version, n_dates,
  pairs:[{date, tile, ours_flooded_frac, opera_water_frac}], note} | null}`
- **B3.9 `provenance.json`:** `{git_sha, created_at, granules:[{granule_id, crid, subset_sha256}],
  artifacts:[{path, sha256}], decomposition_check:{reference, max_abs_diff_db}}`
- **B3.10 Overlays & histograms:** `overlays/<pass_id>_<tile>.png` + `overlays/index.json`
  `[{pass_id,tile,url,coordinates}]`, `hist/<stage>.png`: feature histograms per stage for the Evidence page.
- **B3.11 `story.json`:** `{hero_tile, hero_field_id, headline:{text, tag}, counts:{passes, fields, tiles,
  pct_fields_with_enough_looks}}`

### B4. D1 database schema (`platform/migrations/0001_init.sql`)

```sql
fields(field_id PK, run_id, tile, district, area_ha, source, rice_mask_frac, lon, lat)
passes(pass_id PK, run_id, granule_id, datetime, direction, pol_mode, crid, maturity, used)
observations(field_id, pass_id, run_id, state, p_flooded, confidence, stage,
             hh_db, hv_db, ps_db, pd_db, pv_db, valid_frac, PRIMARY KEY(field_id, pass_id))
summaries(field_id PK, run_id, awd_verdict, drained_hits, clear_looks, p_catch,
          awd_reason, dsr_signal, dsr_reason)
audits(audit_id PK, created_at, budget, seed, input_hash, synthetic, result_json)
meta(key PK, value)
```

### B5. R2 bucket structure (bucket `mudskipper-data`)

- `runs/<run_id>/{aoi,passes,detectability,district_check,checks,provenance,story}.json`
- `runs/<run_id>/fields.pmtiles` · `runs/<run_id>/overlays/*` · `runs/<run_id>/hist/*`
- `live.json {run_id, fixture}` · `basemap/punjab.pmtiles` (optional Protomaps extract)

### B6. API endpoints

- `GET /api/health` · `/api/meta` · `/api/story` · `/api/passes` · `/api/fields?tile=&verdict=&page=`
- `GET /api/fields/:id` · `/api/detectability` · `/api/checks` · `/api/provenance`
- `POST /api/audit {claims: FeatureCollection(properties: claimed, synthetic), budget, seed?}` →
  `{audit_id, matched, unmatched, ranked:[{field_id, rank, score, reason, pick}],
  notice:"Ranking for inspection, not a finding about anyone."}`
- `GET /api/audit/:id` · `GET /tiles/*` (R2 proxy with Range → 206)

**Ranking logic:** weight inconsistent 1.0, not_enough_evidence 0.6, unmatched claim 0.8, consistent 0.1;
score = weight × area_ha; 80% of budget by score, 20% seeded stratified random by district.
Limits: body ≤ 5 MB, ≤ 5,000 claims.

**Connectivity notice:** Volk never calls fetch directly. `core/client.ts` exposes typed functions
(`getStory`, `getPasses`, `getFields`, `getField`, `getDetectability`, `getChecks`, `getProvenance`,
`postAudit`) with a `source: "api" | "fixtures"` switch so the app runs offline in dev.

### B7. Wrangler configuration (`platform/wrangler.jsonc`)

```jsonc
{
  "name": "mudskipper",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-13",
  "assets": {
    "directory": "../app/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/tiles/*"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "mudskipper", "database_id": "<id>" }],
  "r2_buckets": [{ "binding": "DATA", "bucket_name": "mudskipper-data" }]
}
```

### B8. Sources & references

- NISAR availability / gap: hyp3-docs.asf.alaska.edu/nisar-docs/availability-overview/
- GCOV specs & intro: nisar-docs.asf.alaska.edu/gcov/ · nisar-docs.asf.alaska.edu/nisar-intro/
- ASF Cookbook: asfopensarlab.github.io/NISAR_Cookbook/notebooks/gcov-intro
- pyNISAR repo: github.com/Cesarito2021/pyNISAR
- ISRO polarimetric training: github.com/dharmendraisro/nisar-polarimetric-training
- PyPolSARpro: polsarpro.readthedocs.io/en/latest/decompositions/
- polsartools: github.com/polsartools/polsartools
- Ricemapper & paper: github.com/microsoft/rice-irrigation-mapping-s1s2 · arxiv.org/abs/2507.08605
- Fields of the World (FTW): github.com/fieldsoftheworld/ftw-baselines
- OPERA DSWx: podaac.jpl.nasa.gov/OPERA
- PMTiles on Cloudflare: docs.protomaps.com/deploy/cloudflare
- Academic papers: Islam et al. (MDPI) · Jin et al. (MDPI)
- Punjab DSR 2026 news: DT Next article
- RMI rice cultivation: rmi.org/technical-explainer-carbon-credits-for-improved-rice-cultivation/
- Submission guide: spaceappschallenge.org/resources/project-submission-guide

### B9. Fixtures (Lane 0)

A deterministic sample of every artifact: 2 tiles, 300 fields, 12 passes (gap respected, 9 QP + 3 DH), all
three verdicts, 3 overlays, `story.json`, `claims.sample.geojson` (60 SYNTHETIC). The app shows SAMPLE DATA
when `fixture` is true.

---

## PART C — CLAUDE CODE PROMPTS

### LANE 0: BOOTSTRAP (Karthik, first 20 minutes)

Bootstrap the MUDSKIPPER monorepo; two teammates are waiting. Read docs/SPEC.md first.

1. **Repo initialization:** git init (main); create public repo "mudskipper" with gh, or print the commands.
   Create the B1 tree, LICENSE (GPL-3.0-only), NOTICE, .gitignore (`.env`, `data/`, `artifacts/`,
   `node_modules/`, `dist/`, `.venv/`, `__pycache__/`, `*.h5`, `*.tif`, `.wrangler/`).
2. **Schemas:** JSON Schemas (draft 2020-12) for every B3 artifact and B6 response.
3. **Fixtures & scripts:** `contracts/make_fixtures.py` (stdlib, seeded) producing B9, consistent with the
   B3.5 logic; `contracts/validate.py`; Makefile targets `fixtures`, `validate`, `publish`, `help`.
4. **Log decisions:** DECISIONS.md seeded: study area, coverage result (TODO if unknown), license reason,
   evidence rule, "processing offline, serving on Cloudflare", the A4 design decision, deadline TODO, owners
   (Volk app, Karthik platform/core/geo, Ishaan pipeline).
5. **Documentation stub:** README stub: one-line pitch, criterion table placeholder, owners, how to run on
   fixtures, credits.
6. **Commit & push:** Commit with the runner's identity, no AI trailers. Tag `v0-foundation`. Push. Print URL.

Constraint: Do not start lane work. Do not ask questions.

### LANE ISHAAN: ML / RADAR (`pipeline/`)

You are the ML and radar engineer on MUDSKIPPER. `git pull --rebase`. Read docs/SPEC.md and
contracts/CONTRACTS.md. You own `pipeline/` only. Your single deliverable is a correct `observations.jsonl`;
everything downstream depends on it. Correctness first.

Scope note: You do NOT implement the simulation, verdicts or ranking (`core/` does); you review their
parameters and write the Methods and Limits text.

Read before coding: ASF NISAR Data User Guide (GCOV, availability, known issues), the ASF NISAR Cookbook GCOV
notebooks, the pyNISAR README, the nisar-polarimetric-training modules on GCOV QC and Freeman–Durden, the
PyPolSARpro `freeman` docs. Check licenses.

1. **Search:** `search.py`: run the A6 check for the tiles in `aoi.json`; choose one track, frame, direction
   and CRID; write `passes.json` with `used` / `excluded_reason`. Exclude anything in the gap window.
2. **Fetch:** `fetch.py`: bounded remote reads of each tile's window only. Prefer earthaccess + fsspec + h5py
   on `/science/LSAR/GCOV/grids/frequencyA`; pyNISAR `process_scene(aoi=..., max_mb=...)` is the fallback.
   Cache under `data/` with sha256.
3. **Process:** `process.py`, per pass and tile: read HHHH, HVHV, VHVH, VVVV and, when present, HHVV; apply the
   GCOV mask; average HV and VH; set gap stripes to NaN; record valid fraction. Always produce `hh_db`,
   `hv_db`, `hh_hv_db`. Quad-pol: aggregate the covariance terms per field in linear units first, then run
   Freeman–Durden (Ps, Pd, Pv) in numpy; clip negatives. Cross-check one pass against PyPolSARpro or
   polsartools and write `max_abs_diff_db` into provenance.
4. **Zonal stats:** `zonal.py`: per field `n_px`, `valid_frac`, means in linear power then dB; stage by date
   (early < Jul 15 ≤ mid < Sep 10 ≤ late; configurable). Use geo's `fields.geojson`; a labeled grid version
   arrives at H+0:45 and FTW polygons at H+3. Rerun when it changes.
5. **Classification:** `classify.py`: per stage, a 2-component Gaussian mixture on the available features
   (`fd_gmm_v1` for quad-pol, `hhhv_v1` for dual-pol). Label components with physics: early stage, flooded =
   lower HH and lower surface power (specular water). For mid and late stages choose the label direction from
   the data and log the reason in DECISIONS.md, because published studies disagree. Emit `p_flooded`, apply
   the B3.4 uncertain rule, save per-stage feature histograms to `hist/`.
6. **Overlays & provenance:** `overlays.py` (B3.10) and `provenance.py` (B3.9).
7. **Day 2 checks:** `checks.py`: season shape; OPERA cross-check per tile and date within ±2 days (DSWx-NI
   via earthaccess if retrievable, else DSWx-S1 or DSWx-HLS), aggregate only, with the 30 m / 3 ha caveat in
   the note. Then `docs/METHODS.md` and the Limits text.
8. **Stretch only:** ISRO S-band from Bhoonidhi as an extra observed layer.

Tests: schema, determinism, gap exclusion, one CRID, Freeman–Durden on a synthetic covariance with a known
answer, linear-power averaging.

Hand-offs: H+2 coverage + first pass; H+3 first `observations.jsonl`; H+6 all passes. If nothing validates by
H+3, tell Karthik and pair. Never invent a pass. Start now.

### LANE KARTHIK: BACKEND + CONNECTIVITY (`platform/`, `core/`, `geo/`)

You are the backend and integration engineer on MUDSKIPPER. `git pull --rebase`. Read docs/SPEC.md and
contracts/CONTRACTS.md. You own `platform/`, `core/` and `geo/`. You are the bridge: Ishaan's files in,
Volk's typed data out. Everything users touch is Cloudflare.

Read first: current Cloudflare docs for Workers static assets (`run_worker_first`, `not_found_handling`), Hono
on Workers, D1 migrations and batch limits, R2 range reads, wrangler-action; the FTW CLI docs; the Ricemapper
README (MIT). Do not invent APIs.

1. **Initial grid (by H+0:45):** `geo/grid.py`: `aoi.json` for both real tiles and a labeled 40 m grid
   `fields.geojson` (source "grid") so Ishaan can start zonal stats immediately.
2. **Platform setup (by H+1):** `wrangler.jsonc` per B7; migration per B4; Hono routes per B6 serving the
   fixture set; deploy; post the URL. GitHub Actions: typecheck, test, build app, wrangler deploy on main.
   Data publishing stays manual.
3. **Field polygons (start H+1):** `geo/fields.py` (runs in background): `ftw inference all` on Sentinel-2 for
   each tile (CPU is fine; newest recommended model per the FTW docs), filter by land cover, polygonize; apply
   the Han et al. rice mask; drop < 0.5 ha; cap 5,000 fields; write `fields.geojson` + `fields.pmtiles`. If it
   fails by H+3, keep the grid and label it.
4. **Core package (by H+5):** TypeScript, zero runtime dependencies: `types.ts` generated from schemas;
   `sim.ts` (B3.6 simulation, seeded, pure); `verdicts.ts` (B3.5 logic, per-field `p_catch` computed from
   clear-look dates); `rank.ts` (B6 ranking); `story.ts` (B3.11 selection); `client.ts` (typed API client with
   api/fixtures switch). Tests: determinism, scripted verdict cases, ranking share and seed.
5. **Publish script (by H+8):** `platform/scripts/publish.ts`: validate artifacts; run core to write
   `detectability.json`, `field_summary.jsonl` and `story.json`; upload to R2; idempotent D1 load in batches;
   update meta and `live.json`; `--fixtures` publishes the sample set. `/api/audit` uses core/rank and stores
   results. `/tiles` proxy supports Range.
6. **Day 2 tasks:** `geo/district_check.py` (B3.7) with 2026 figures for Fazilka, Sri Muktsar Sahib,
   Ferozepur; `geo/claims_sample.py` (60 SYNTHETIC claims on real field ids); Open Graph image and meta tags
   for `/`; README with criterion table; data behind `/judges`. Optional: Protomaps basemap extract in R2.

Hand-offs: H+0:20 foundation; H+0:45 grid; H+1 URL; H+3 fields; H+5 core; H+8 real run live.
Describe evidence, never people. Start with Lane 0 if it has not been run.

### LANE VOLK: FRONTEND + UI + PAGE + VIDEO (`app/`)

You are the designer-engineer on MUDSKIPPER and you own what judges see. `git pull --rebase`. Read
docs/SPEC.md, docs/WIN_GUIDE.md and contracts/CONTRACTS.md. Global judges see only the project page, a
30-second video and this site, usually on a phone.

Stack: Vite + TypeScript, MapLibre GL JS, the pmtiles protocol, `core/` (types, client, sim, rank). Hand-built
SVG charts. No component library. Read current docs for each.

Data client: All data comes through `core/client.ts`; start with source "fixtures", switch to "api" when
Karthik posts the URL. Never call fetch directly.

App routes: `/` Story · `/map` · `/field/:id` · `/lab` · `/scarecrow` · `/evidence` · `/methods` · `/judges`

1. **Story (`/`):** the question as the headline; the hero tile animating behind it; the headline from
   `story.json` with its tag; two buttons (tour, judges); short scroll: problem → how radar sees water → what
   we found → limits.
2. **Tour (`?tour=1`):** 45 s, no input, loops; script in `app/src/tour.json`.
3. **Record mode (`?record=1&scene=<name>`):** fixed 1920×1080 stage, no cursor, deterministic timings,
   captions rendered in-page exactly as in WIN_GUIDE section 7.
4. **Automated capture:** `scripts/capture.ts` (Playwright + ffmpeg), single `npm run capture` command:
   `video.mp4` (≤ 30.0 s, 1080p H.264), `video_vertical.mp4`, `hero.gif` (< 10 MB, 1200 px) and five page
   images per WIN_GUIDE section 5. Rerun on data changes.
5. **Screens & interactivity:** evidence tags on every number; gap band on every time axis; SAMPLE DATA and
   SYNTHETIC badges; deep link for every state. Lab runs core/sim in browser; Scarecrow uses core/rank for
   sample and `POST /api/audit` for uploads.
6. **Judges view (`/judges`):** the criterion table, one sentence and one deep link each.
7. **Page copy:** `docs/PAGE.md`: project page copy from WIN_GUIDE section 4 with numbers populated by script
   from API so nothing is typed by hand.

Quality requirements: portrait phone first (390×844), then 1920×1080; interactive < 3 s on throttled 4G;
`prefers-reduced-motion` respected; check screenshots after every change.

Hand-offs: H+4 Story + Map + tour on fixtures, deployed; H+10 page draft + hero GIF; Day 2 PM video.
Original art only; no NASA logos. Start now.

---

## PART D — DESIGN SYSTEM

- **D1. Feel:** a calm field instrument. Dark and precise; water and mud are the only bright colors. No
  dashboard clichés, no glow, no gradients on panels.
- **D2. Palette:**

  | Token | Hex | Use |
  |-------|-----|-----|
  | Night paddy | `#0E1A1F` | background |
  | Bank | `#16262D` | panels |
  | Silt | `#2C3E46` | hairlines |
  | Paper | `#EAE6DA` | text |
  | Reed | `#9FB0A8` | secondary |
  | Water | `#3FA7D6` | flooded |
  | Mud | `#C98B4E` | drained |
  | Rice | `#7BC67E` | consistent |
  | Haze | `#8A8F98` | hatched = uncertain / gap |
  | Scarecrow | `#E8553D` | inspection picks only |
  | Violet | `#A99BFF` | ASSUMED tags |

- **D3. Typography (self-hosted):** Fraunces for headlines and verdicts · IBM Plex Sans for UI · IBM Plex Mono
  for all numbers, dates and IDs (tabular). Minimum 16 px on mobile. Video captions: Plex Sans 600, 64 px at
  1080p, Paper on a Bank bar, bottom third.
- **D4. Tags:** OBSERVED solid Paper chip · INFERRED outlined Water chip · ASSUMED outlined Violet chip with its
  source on tap.
- **D5. Terminology:** "clear looks"; "consistent with AWD" / "not consistent with AWD" / "not enough
  evidence"; "satellite evidence". Never "fraud", "cheating" or "proof of".
- **D6. Motion:** the season steps every 600 ms; the gap band holds 1 s labeled "no data"; chart tweens
  150 ms; nothing else moves.
- **D7. Logo/mark:** an original two-tone line drawing of a mudskipper, half in Water, half on Mud.

### D8. Limits box (same text on the site, the page and the README)

> No 2026 ground truth in Punjab yet. NISAR revisits every 12 days and has a data gap from Jul 27 to Aug 10,
> 2026. Data are provisional. States are inferred without labels. DSR is a signal, not proof. We show
> irrigation evidence, not emissions.
