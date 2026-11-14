# MUDSKIPPER — CONTRACTS v1

This is the single source of truth for every file and API response that crosses a lane boundary. It copies
SPEC Part B and adds the detail Part B leaves open, so that three people can build at once without guessing.

- **Machine-readable form:** [`schemas/`](schemas) (JSON Schema draft 2020-12). If this text and a schema
  disagree, that is a bug; fix both in the same commit.
- **Reference behavior:** [`rules.py`](rules.py) implements every normative rule below in plain Python. It
  exists only so fixtures are self-consistent and `validate.py` can check real runs. The production
  implementation is `core/` (TypeScript, SPEC A4), and core's tests must reproduce the fixture outputs
  exactly. That cross-language check is how we know the rule exists once.
- **Change policy (SPEC A10):** additive only after `v0-foundation`; one line in [`../DECISIONS.md`](../DECISIONS.md);
  message the team. Removing or renaming a field means a v2 file next to v1, never an edit in place.

Keywords: **MUST**, **SHOULD** and **MAY** are used as in RFC 2119. "Validator" means `contracts/validate.py`.
JSON examples show shape only; their numbers are illustrative, not results. Real values live in
[`fixtures/`](fixtures) (sample) and `artifacts/<run_id>/` (real).

---

## C0. Conventions that apply everywhere

| Thing | Rule |
|---|---|
| Header | Every JSON file and every JSONL **line** has `"v": 1` and `"run_id"`. |
| Fixture flag | Fixture files add `"fixture": true`. Real artifacts omit it or set `false`. Every **API response** MUST carry `fixture` as a boolean, because the app shows the SAMPLE DATA badge from it (T8). |
| `run_id` | `^[a-z0-9][a-z0-9_-]{0,31}$`. Real runs use `r01`, `r02`, …; the fixture run is `fixture`. |
| Tile id | `^[a-z][a-z0-9]{0,15}$`, e.g. `fazilka`, `muktsar`. |
| `field_id` | `<tile>-<5 digits>`, e.g. `fazilka-00042`. Stable within a run; never derived from a person or a parcel register. |
| `pass_id` | `YYYYMMDD-T<track, 3 digits><A or D>`, e.g. `20260623-T135D` (UTC acquisition date, relative orbit, direction). A second product of the same acquisition (kept only as an excluded duplicate) adds a short suffix, e.g. `20260915-T135D-ur`. |
| Datetime | UTC, whole seconds, `Z` suffix: `2026-06-23T13:47:34Z`. |
| Date | `YYYY-MM-DD`; it means 00:00:00Z on that day. |
| Units | Backscatter in dB (`10·log10` of linear power, averaged in **linear** first). Areas in hectares. Probabilities in [0, 1]. A field named `pct_*` is in [0, 100]. |
| Geometry | WGS84 lon/lat (GeoJSON). Area and length are computed in the run's UTM zone (`utm_epsg`). |
| Rounding | Writers MAY round stored floats to 6 decimals. Rule outputs from `core` (probabilities, scores) are written unrounded so both languages can compare them exactly. |
| Percent shown to people | `floor(100·p + 0.5)` (round half up), the same in Python and TypeScript. |
| JSON writing | UTF-8, LF line endings, no BOM, keys in the order the schema lists them. Re-running a writer on the same inputs MUST give byte-identical output (T2). |
| Finite numbers only | No `NaN`, `Infinity` or `-Infinity` anywhere (Python's `json.dumps` writes them by default; pass `allow_nan=False`). A linear power ≤ 0 is clipped to 1e-8 (−80 dB) before converting to dB. The validator rejects non-finite numbers. |
| Datetime in JS | `new Date(ms).toISOString().slice(0, 19) + "Z"` (whole seconds; `toISOString()` alone adds milliseconds and fails the schema). |
| String order | Every sort of ids, keys or district names compares UTF-16 code units (JavaScript's default `sort()`, Python's `sorted()` for BMP text). Never `localeCompare`. Ids are ASCII by pattern. |
| Cross-language equality | "Reproduce exactly" means the parsed JSON values are equal: same strings, same numbers by value (Python writes `1.0` and `2.5e-05`, JavaScript writes `1` and `0.000025`; both parse to the same double). Compare parsed values, never bytes, across languages. |
| Optional numbers | Treat `seed: 0` as a seed; test for absence with `=== undefined` or `is None`, never by truthiness. |

### Evidence tags (SPEC evidence rule, T12)

Every number in the UI, API, README and video carries exactly one tag. **OBSERVED** is a radar measurement.
**INFERRED** is our model's reading. **ASSUMED** is a cited parameter. The tag for each artifact field is
fixed in [`evidence_tags.json`](evidence_tags.json), so the app looks it up instead of deciding per screen.
ASSUMED values carry their citation from `detectability.json → param_sources` or from `district_check.json →
source_urls`.

---

## B1. Repository layout

```
README.md DECISIONS.md LICENSE NOTICE Makefile .env.example
docs/       SPEC.md WIN_GUIDE.md PAGE.md
contracts/  CONTRACTS.md schemas/ fixtures/ make_fixtures.py validate.py rules.py evidence_tags.json tests/
pipeline/   Ishaan, Python (radar)
geo/        Karthik, Python (fields, district table, sample claims)
core/       Karthik, TypeScript package (sim, verdicts, ranking, story, API client, types)
platform/   Karthik, Cloudflare Worker + publish script + migrations
app/        Volk, Vite + TypeScript
data/       gitignored: raw downloads and caches
artifacts/<run_id>/   gitignored: one run's files, published to R2/D1
```

## B2. Environment (`.env.example`)

`EARTHDATA_USERNAME`, `EARTHDATA_PASSWORD`, `RUN_ID`, `AOI_TILES`, `SEASON_START`, `SEASON_END`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (CI secrets only). `AOI_TILES` is
`id:minLon,minLat,maxLon,maxLat;id:…`. No script reads `.env` implicitly; each one documents the keys it needs.

---

## B3. Run artifacts (`artifacts/<run_id>/`)

| File | Schema | Written by | Read by | Required at stage |
|---|---|---|---|---|
| `aoi.json` | `aoi` | geo | pipeline, publish, app | pipeline |
| `fields.geojson` (+ `fields.pmtiles`) | `fields` | geo | pipeline, publish, app | pipeline |
| `passes.json` | `passes` | pipeline | core, publish, app | pipeline |
| `observations.jsonl` | `observation` (per line) | pipeline | core, publish | pipeline |
| `overlays/index.json` + `overlays/*.png` | `overlays_index` | pipeline | publish, app | pipeline |
| `hist/<stage>.png` | (PNG) | pipeline | publish, app | pipeline |
| `provenance.json` | `provenance` | pipeline (+ publish) | app | pipeline |
| `checks.json` | `checks` | pipeline | app | optional (Day 2) |
| `district_check.json` | `district_check` | geo | app | optional (Day 2) |
| `claims.sample.geojson` | `claims` | geo | app, audit | optional |
| `detectability.json` | `detectability` | publish (core) | app | published |
| `field_summary.jsonl` | `field_summary` (per line) | publish (core) | app | published |
| `story.json` | `story` | publish (core) | app | published |

"Stage" is how far a run has got. A **pipeline** run has Ishaan's and geo's files. A **published** run also
has core's outputs. The validator picks the stage automatically (published if `field_summary.jsonl` exists)
or takes `--stage`.

### B3.1 `aoi.json`

```json
{"v":1,"run_id":"r01",
 "tiles":[{"id":"fazilka","district":"Fazilka","bbox":[minLon,minLat,maxLon,maxLat]}],
 "utm_epsg":32643,
 "season":{"start":"2026-06-17","end":"2026-10-23"},
 "stages":{"mid_start":"2026-07-15","late_start":"2026-09-10"},
 "gaps":[{"start":"2026-07-27T22:03:25Z","end":"2026-08-10T00:55:27Z","source":"https://nisar-docs.asf.alaska.edu/availability-overview/"}]}
```

- `stages` (v1 addition): a pass is **early** if `datetime < mid_start`, **mid** if `mid_start ≤ datetime <
  late_start`, and **late** otherwise. The default matches SPEC Lane Ishaan step 4.
- `gaps` MUST include the permanent NISAR gap above. Gap intervals are closed: a time equal to either bound
  is inside the gap.
- Tiles are about 15 × 15 km, one per district, inside one NISAR frame and one orbit direction (SPEC A2).

### B3.2 `passes.json`

```json
{"v":1,"run_id":"r01","passes":[{
  "pass_id":"20260623-T135D",
  "granule_id":"NISAR_L2_PR_GCOV_023_135_D_073_4005_DHDH_A_20260623T134734_20260623T134809_P05023_N_F_J_001",
  "datetime":"2026-06-23T13:47:34Z","direction":"descending","track":135,"frame":73,
  "pol_mode":"DH","covariance_terms":["HHHH","HVHV"],"crid":"P05023","maturity":"provisional","pixel_m":10,
  "valid_fraction_by_tile":{"fazilka":0.98,"muktsar":0.97},"used":true,"excluded_reason":null}]}
```

- `granule_id` is the full NISAR granule name with no extension. Real runs MUST match the official
  pattern (`NISAR_L2_{PR|UR|OD}_GCOV_…`, 18 underscore-separated fields; see the ASF naming page).
  **Fixture granule ids start with `SAMPLE_`**, so a sample id can never be mistaken for a real one (T3).
- `datetime` is the granule's start time. `direction` is `ascending` or `descending`; `track` is 1–173;
  `frame` is 1–176. `pol_mode` is `QP` (quad-pol) or `DH` (HH/HV dual-pol). `maturity` is `beta`,
  `provisional` or `validated`.
- `used: false` passes MUST give `excluded_reason`, one of: `in_data_gap`, `outside_season`,
  `direction_not_selected`, `track_not_selected`, `frame_not_selected`, `crid_mismatch`,
  `duplicate_product`, `low_valid_fraction`, `processing_failed`. `used: true` passes have
  `excluded_reason: null`.
- **Series and CRIDs (T4):** a series is the used passes sharing (`direction`, `track`, `frame`). Each series
  MUST have exactly one `crid`. At most two directions may be used (SPEC A6 fallback); when there are two,
  classification thresholds are per direction.
- **Gap (T5):** no pass whose `datetime` falls inside a gap may be `used`.
- **PR and UR products:** the same acquisition can exist as a Production (`PR`) and an Urgent Response
  (`UR`) product, and as mixed-mode or partial-frame splits. Keep one granule per acquisition, prefer `PR`
  with full coverage (`…_F_J_…`), and mark the rest `duplicate_product`.

### B3.3 `fields.geojson` (+ `fields.pmtiles`)

A GeoJSON FeatureCollection with top-level `v`, `run_id` (and `fixture`) as foreign members. Each feature
has a `Polygon` or `MultiPolygon` geometry and:

| Property | Rule |
|---|---|
| `field_id` | see C0; unique |
| `tile`, `district` | tile id from `aoi.json`; district name of that tile |
| `area_ha` | ≥ 0.5, computed in UTM |
| `source` | `ftw` \| `manual` \| `grid` |
| `rice_mask_frac` | share of the polygon on rice in the rice mask, in [0.5, 1] |
| `lon`, `lat` | (v1 addition) a label point inside the polygon, used for map labels, D1 and nearest-field lookups |

At most 5,000 features. `fields.pmtiles` holds the same features (layer `fields`) for the map; GeoJSON stays
the source of truth.

### B3.4 `observations.jsonl` (one line per field per used pass)

```json
{"v":1,"run_id":"r01","field_id":"fazilka-00042","pass_id":"20260623-T135D","n_px":118,"valid_frac":0.97,
 "observed":{"hh_db":-14.2,"hv_db":-22.9,"hh_hv_db":8.7},"stage":"early",
 "inferred":{"state":"flooded","p_flooded":0.91,"confidence":0.82,"method":"hhhv_v1"},"flags":[]}
```

- `n_px` is the number of pixels whose centre falls in the field; `valid_frac` is the share of those that
  pass the GCOV mask and the gap-stripe mask.
- `observed` always has `hh_db`, `hv_db` and `hh_hv_db` (= `hh_db − hv_db`, within 0.01 dB). Quad-pol
  passes add `vv_db`, `ps_db`, `pd_db` and `pv_db` (Freeman–Durden, from field-averaged linear covariance).
  When `valid_frac == 0`, the observed values MAY be `null`.
- `stage` MUST equal the stage of the pass datetime (B3.1).
- `method` is `fd_gmm_v1` (needs the quad-pol components) or `hhhv_v1`. A `DH` pass MUST use `hhhv_v1`. A
  `QP` pass MAY use either, so one series can keep one method.
- **Uncertain rule:** `state` is `uncertain` if `valid_frac < 0.6`, or `p_flooded` is `null`, or
  `0.35 < p_flooded < 0.65`. Otherwise it is `flooded` when `p_flooded ≥ 0.65` and `drained` when
  `p_flooded ≤ 0.35`. Apply the rule to the values **as written** (after any rounding), so the file always
  agrees with itself.
- `confidence = |2·p_flooded − 1|` (0 is a coin flip, 1 is certain). It is `null` when `p_flooded` is `null`.
- `flags`: snake_case strings. Known values are `gap_stripe`, `low_valid_frac`, `few_pixels` (n_px < 10),
  `edge_of_swath`, `rfi` and `dual_pol_only`. New flags are an additive change.
- A **clear look** is an observation whose state is `flooded` or `drained`.

### B3.5 `field_summary.jsonl` (one line per field; written by core)

```json
{"v":1,"run_id":"r01","field_id":"fazilka-00042",
 "awd":{"window":{"start":"2026-07-07T13:47:34Z","end":"2026-09-16T13:47:34Z","source":"inferred"},
        "clear_looks":6,"drained_hits":3,"p_catch_ge1_if_awd":0.9731,"k_star":2,
        "verdict":"consistent","reason":"Drained on 3 of 6 clear looks, more than a continuously flooded field would show."},
 "dsr":{"signal":"transplant_signal","reason":"Standing water on 2026-06-23, typical of puddled transplanting."}}
```

**Normative rule (core/verdicts.ts; Python reference `rules.field_summary`).** Parameters come from
`detectability.json → params`. Write `a0, a1` = `awd_window_days_after_transplant`.

1. **AWD window.** Let `F` be the field's clear looks with stage `early` and state `flooded`. If `F` is not
   empty, `T` = the datetime of the earliest one and `source = "inferred"`. Otherwise `T` = the midpoint of
   `transplant_window` (start 00:00Z plus half the span) and `source = "assumed"`. Then `window.start = T + a0`
   days and `window.end = T + a1` days, as datetimes. `start` is inclusive and `end` exclusive.
2. **Looks.** `clear_looks` = the field's clear looks with `start ≤ datetime < end`. `drained_hits` = those
   with state `drained`.
3. **Per-field detectability.** Run the simulation (B3.6a) on exactly those clear-look datetimes, with the
   window fixed to `[start, end)`. `p_catch_ge1_if_awd` = P(at least one drained label | AWD). `k_star` =
   the smallest k ≥ 1 with P(at least k drained labels | CF) ≤ `cf_false_flag_max`, or `null` if there is no
   such k. With `clear_looks = 0`, `p_catch_ge1_if_awd = 0` and `k_star = null`. Here
   P(at least k) = (Σ_{j ≥ k} count_j) / n_sim (one integer sum, one division), and k ranges over 1…`clear_looks`.
4. **Verdict**, first match wins:
   - `consistent` if `k_star ≠ null` and `drained_hits ≥ k_star`.
   - `inconsistent` if `clear_looks ≥ 1`, `drained_hits = 0` and `p_catch_ge1_if_awd ≥ 1 − awd_miss_max`.
     (These looks would have caught an AWD field, and none did.)
   - `not_enough_evidence` otherwise.
5. **Reason** (exact text). `{looks}` is "1 clear look" or "N clear looks"; `{all}` is "the only clear look"
   or "all N clear looks"; `{p}` is `p_catch_ge1_if_awd` as a percent **rounded down**,
   `floor(100·p + 1e-9)`, so a field just under the 90% bar never reads "90%":
   | Case | Text |
   |---|---|
   | consistent | `Drained on {d} of {looks}, more than a continuously flooded field would show.` |
   | inconsistent | `Flooded on {all}; a field practicing AWD would have been caught drained {p}% of the time.` |
   | n = 0 | `No clear looks inside the AWD window.` |
   | d = 0, low p | `Flooded on {all}, but these dates would catch a field practicing AWD only {p}% of the time.` |
   | k_star null | `{looks} cannot separate AWD from continuous flooding.` |
   | 0 < d < k_star | `Drained on {d} of {looks}; {k} are needed to rule out a single drainage.` |
   The `not_enough_evidence` rows are checked in this order: n = 0, d = 0, k_star null, otherwise.
6. **DSR signal.** Let `E` be the field's clear looks with stage `early`, sorted by time.
   - `unknown` if `|E| = 0`: `No clear looks before {mid_start}.` (the date from `aoi.stages`)
   - `unknown` if `|E| < dsr_min_early_looks`: `Only {looks} before {mid_start}.`
   - `transplant_signal` if any look in `E` is flooded: `Standing water on {date}, typical of puddled transplanting.`
     (`{date}` is the date of the first flooded look)
   - `dsr_signal` otherwise: `Dry on all {looks} before {mid_start}, typical of direct seeding.`

Words follow SPEC D5: "consistent with AWD", "not consistent with AWD", "not enough evidence". Never "fraud",
"cheating" or "proof of".

### B3.6 `detectability.json` (written by core)

```json
{"v":1,"run_id":"r01","seed":20261114,"n_sim":4000,
 "pass_dates":["2026-06-23T13:47:34Z", "…"],
 "params":{"transplant_window":{"start":"2026-06-05","end":"2026-07-15"},
   "awd_window_days_after_transplant":[14,85],"cycle_days":[4,10],"drained_fraction_of_cycle":[0.3,0.5],
   "cf_single_drain_prob":0.51,"per_pass_accuracy":{"early":0.94,"mid":0.8,"late":0.8},
   "stage_boundaries":{"mid_start":"2026-07-15","late_start":"2026-09-10"},
   "cf_false_flag_max":0.1,"awd_miss_max":0.1,"dsr_min_early_looks":2},
 "param_sources":{"cycle_days":{"citation":"Shah et al., AAAI 2026","url":"https://arxiv.org/abs/2507.08605","status":"cited","note":"…"}, "…":{}},
 "results":{"awd":{"p_ge1":0.99,"p_ge2":0.93,"p_ge3":0.81,"dist":[…]},
            "cf":{"p_ge1_false":0.41,"p_ge2_false":0.07,"dist":[…]},
            "k_star":2,"k_star_rule":"smallest k with cf false-flag ≤ 0.10"},
 "sentence":"With 10 passes, a field practicing AWD is caught drained at least twice 93% of the time; a continuously flooded field shows that 7% of the time."}
```

- `pass_dates` are the datetimes of all `used` passes, sorted. The season-level simulation treats each as a
  clear look.
- `params.stage_boundaries` MUST equal `aoi.stages`: the simulation and the observation stages use one
  calendar.
- `cf_false_flag_max` and `awd_miss_max` are fixed at 0.1 in v1 (the schema enforces it), which is why
  `k_star_rule` is a constant string.
- v1 additions: `per_pass_accuracy` is per stage; `stage_boundaries`, `cf_false_flag_max`, `awd_miss_max`
  and `dsr_min_early_looks` sit in `params`, so the sim and the verdicts read one object; `results.*.dist[j]`
  = P(exactly j drained labels) for j = 0…n, which the Lab charts plot directly.
- `param_sources` has one entry per key of `params`: `{citation, url|null, status, note}`, where `status` is
  `cited` (stated by the source), `derived` (computed from cited figures; `note` shows how), `convention`
  (our own rule, defined in this file) or `needs_citation`. **A real (non-fixture) run MUST NOT contain
  `needs_citation`**; the validator fails it.
- `sentence` (exact text, k = `results.k_star`, `{passes}` is "1 pass" or "N passes", `{x times}` is
  `once`, `twice` or `k times`):
  - if `k_star` is not null: `With {passes}, a field practicing AWD is caught drained at least {x times}
    {p_awd}% of the time; a continuously flooded field shows that {p_cf}% of the time.` Here `p_awd` =
    P(≥k | AWD) and `p_cf` = P(≥k | CF), computed from `dist` counts as in B3.5, as percents (C0).
  - if `k_star` is null: `With {passes}, no count of drained looks separates AWD from continuous flooding at
    a 10% false-flag rate.`

#### B3.6a Simulation (normative; core/sim.ts, Python `rules.simulate`)

Everything is plain IEEE-754 double arithmetic in the order written, so Python and TypeScript agree to the
bit.

- **Time:** `t(x) = epoch_milliseconds(x) / 86400000` (days). A date means 00:00Z.
- **PRNG:** `mulberry32` on a uint32 state, returning `uint32 / 2^32`:
  ```
  a = (a + 0x6D2B79F5) mod 2^32
  t = imul(a ^ (a >>> 15), a | 1)
  t = ((t + imul(t ^ (t >>> 7), t | 61)) mod 2^32) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  ```
- **Seed derivation:** `derive(seed, key) = fnv1a32(String(seed) + "|" + key)` over the UTF-8 bytes (offset
  basis 2166136261, prime 16777619, mod 2^32).
- **Inputs:** looks `L` (datetime strings, sorted ascending, each with its stage), `params`, `n_sim`, a
  scenario (`awd` or `cf`), a uint32 seed and an optional fixed window `[ws, we)`.
- **Loop**, for each of `n_sim` runs, draw five uniforms in this order: `uT, uC, uF, uP, uX`. Then:
  ```
  if fixed window:  ws, we = t(start), t(end)
  else:             T  = t(tw.start) + uT * (t(tw.end) - t(tw.start)); ws = T + a0; we = T + a1
  C = c0 + uC * (c1 - c0)            # cycle length, days
  f = f0 + uF * (f1 - f0)            # drained share of a cycle
  awd: phi = uP * C
       drained(x) = frac((x - ws + phi) / C) >= 1 - f        # frac(y) = y - floor(y)
  cf:  D = f * C; s = ws + uP * ((we - ws) - D)
       drained(x) = (uX < cf_single_drain_prob) and s <= x < s + D
  k = 0
  for each look x in L (in order):
      u = next uniform                                        # drawn for every look
      if ws <= t(x) < we:
          truth = drained(t(x))
          label = truth if u < per_pass_accuracy[stage(x)] else not truth
          if label: k = k + 1
  dist[k] += 1
  ```
  Every run draws exactly `5 + |L|` uniforms. `dist` has length `|L| + 1`; probabilities are
  `count / n_sim`.
- **Seeds:** at season level, AWD uses `derive(seed, "awd")` and CF uses `derive(seed, "cf")`. Per field, use
  `derive(seed, "awd|" + window.start + "|" + L.join(","))` and the same with `"cf|"`. Two fields with the
  same looks and window therefore get the same numbers.
- `n_sim` for per-field runs is the same `n_sim` as the season run.

### B3.7 `district_check.json` (geo)

```json
{"v":1,"run_id":"r01","year":2026,
 "rows":[{"district":"Fazilka","gov_dsr_acres":155422.77,"gov_farmers":12063,"tile_rice_ha":1234.5,
          "tile_dsr_signal_ha":321.0,"tile_dsr_signal_frac":0.26}],
 "note":"…","source_urls":["https://www.dtnext.in/…"]}
```

`gov_*` values are ASSUMED (cited, from `source_urls`). `tile_*` values are INFERRED from the run's fields:
`tile_rice_ha` = Σ `area_ha` of the district's fields, `tile_dsr_signal_ha` = Σ `area_ha` where
`dsr.signal = dsr_signal`, `tile_dsr_signal_frac` = their ratio. A district with no tile has `null` tile
values. `note` MUST say that a 15 × 15 km tile is not a district and that DSR is a signal, not proof.

### B3.8 `checks.json` (pipeline, Day 2)

```json
{"v":1,"run_id":"r01",
 "season_shape":{"pct_flooded_by_stage":{"early":61.2,"mid":74.0,"late":38.5},"pass":true,"rule":"…"},
 "opera":{"product":"OPERA_L3_DSWX-NI","version":"0.4","n_dates":3,
          "pairs":[{"date":"2026-08-22","tile":"fazilka","ours_flooded_frac":0.41,"opera_water_frac":0.12,"opera_date":"2026-08-22"}],
          "note":"…"}}
```

- `pct_flooded_by_stage[s]` = 100 × flooded clear looks ÷ clear looks in stage `s`, over all fields
  (`null` if a stage has no clear looks). `rule` states, in one sentence, the expected seasonal shape and
  what makes `pass` true.
- `opera` is `null` if the cross-check did not run. Pairs are aggregate per tile and date (±2 days;
  `opera_date`, required, is the matched product date). `note` MUST carry the 30 m / 3 ha caveat.

### B3.9 `provenance.json`

```json
{"v":1,"run_id":"r01","git_sha":"3f2a9c1","created_at":"2026-11-14T20:00:00Z",
 "granules":[{"granule_id":"NISAR_L2_PR_GCOV_…","crid":"P05023","subset_sha256":"…"}],
 "artifacts":[{"path":"passes.json","sha256":"…"}],
 "decomposition_check":{"reference":"PyPolSARpro freeman, pass 20260822-T135D","max_abs_diff_db":0.03}}
```

- `granules` MUST contain the granule of **every** pass in `passes.json`, used or excluded (T3: every pass
  maps to a real granule id), with the same CRID. `subset_sha256` is the hash of the cached subset, or `null`
  for a pass that was never fetched (an excluded one).
- `artifacts` lists every other file in the run directory (relative POSIX paths, sorted), except
  `provenance.json` itself, with its sha256. Publish re-writes this list after adding core's outputs.
  The validator checks every hash and fails on any file that is not listed.
- `max_abs_diff_db` is `null` until the check runs (DH-only runs have nothing to decompose).
- `created_at` comes from the run configuration, not the wall clock, so reruns hash identically (T2).

### B3.10 Overlays and histograms

- `overlays/<pass_id>_<tile>.png`: an RGBA PNG of one tile on one pass, north up, covering the tile bbox.
- `overlays/index.json` (v1 clarification: an object, so it can carry `v` and `run_id`):
  `{"v":1,"run_id":…,"overlays":[{"pass_id","tile","url":"overlays/<pass_id>_<tile>.png","coordinates":[[lon,lat]×4]}]}`.
  `url` is relative to the run directory. `coordinates` are the four corners in MapLibre image-source order:
  top-left, top-right, bottom-right, bottom-left.
- `hist/<stage>.png`: feature histograms for each stage present (`early`, `mid`, `late`), flooded against
  drained, for the Evidence page.

### B3.11 `story.json` (written by core)

```json
{"v":1,"run_id":"r01","hero_tile":"fazilka","hero_field_id":"fazilka-00042",
 "headline":{"text":"71% of 300 rice fields had enough clear radar looks for a drainage verdict.","tag":"INFERRED"},
 "counts":{"passes":10,"fields":300,"tiles":2,"pct_fields_with_enough_looks":71}}
```

**Normative rule (core/story.ts; Python `rules.story`):**

- A field is **decided** if its verdict is not `not_enough_evidence`.
- `counts.passes` = used passes, `counts.fields` = fields, `counts.tiles` = tiles in `aoi.json`, and
  `pct_fields_with_enough_looks` = percent (C0) of fields that are decided.
- `hero_tile` = among tiles that have at least one field, the one with the highest share of decided fields
  (ties: first in `aoi.tiles` order). A run with no fields has no story.
- `hero_field_id` = in the hero tile, the `consistent` field with the most `drained_hits`, then the most
  `clear_looks`, then the largest `area_ha`, then the smallest `field_id`. If no field there is
  consistent, use the same ordering over decided fields; if none is decided, the smallest `field_id`.
- `headline.text` = `{pct}% of {fields} rice fields had enough clear radar looks for a drainage verdict.`
  `headline.tag = "INFERRED"`.

### B3.12 `claims.sample.geojson` (geo) and uploaded claims

A FeatureCollection of claims. Geometry is a `Point`, `Polygon` or `MultiPolygon`. Properties:

| Property | Rule |
|---|---|
| `claimed` | required; non-empty array of `awd` and/or `dsr`: the practice the program pays for (SPEC B6) |
| `synthetic` | required boolean; the sample file is all `true` (SPEC B6) |
| `claim_id` | optional (v1 addition), `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, unique in the upload; never a person's name or ID number. A missing one becomes `#<n>` (1-based position in the upload). A repeated one is rejected (`400 duplicate_claim_id`). |
| `field_id` | optional hint; used for matching when present and known |
| `area_ha` | optional claimed area (≥ 0), used only for unmatched claims |

Uploads are ordinary GIS exports, so the schema accepts extra members (`name`, `crs`, `bbox`), extra
properties (ignored) and positions with an altitude (ignored). Polygon rings MUST be closed (first position
equals last) with at least 4 positions, otherwise `400 invalid_geometry`.

The sample has exactly 60 SYNTHETIC claims on real field ids of the same run, plus a few points that do not
match any field, so the unmatched path is visible.

### live.json (R2 root)

`{"v":1,"run_id":"r01","fixture":false,"updated_at":"…"}`. It names the run the Worker serves. Publish flips
it last, after R2 and D1 hold the whole run.

---

## B4. D1 schema (`platform/migrations/0001_init.sql`)

As SPEC B4. Columns the API needs that B4 does not list (`vv_db`, `hh_hv_db`, `n_px`, `method`, `flags`
as JSON text, `geometry` as GeoJSON text, `k_star`, `window_*`) are additive migrations owned by platform,
logged in DECISIONS.md.

## B5. R2 layout (bucket `mudskipper-data`)

`runs/<run_id>/<same relative paths as the run directory>` · `live.json` · `basemap/punjab.pmtiles`
(optional). `/tiles/<key>` proxies `<key>` from R2 with Range support (`206 Partial Content`).

---

## B6. HTTP API

All successful responses are JSON with `"v":1`, `"run_id"` (the live run) and `"fixture"` (boolean), except
`/tiles/*`. Errors are only `{"error":{"code":"…","message":"…"}}` with a 4xx/5xx status (schema `api/error`).
Audit error codes: `invalid_json`, `invalid_request` (schema), `too_large` (413, body > 5 MB),
`too_many_claims`, `duplicate_claim_id`, `invalid_geometry`.

| Method and path | Response schema | Notes |
|---|---|---|
| `GET /api/health` | `api/health` | `{ok, v, run_id, fixture, time}` |
| `GET /api/meta` | `api/meta` | season, stages, gaps, tiles, counts, pol modes, methods, CRIDs, asset URLs, Limits text |
| `GET /api/story` | `api/story` | `story.json` + `fixture` |
| `GET /api/passes` | `api/passes` | `passes.json` + `fixture` |
| `GET /api/fields?tile=&verdict=&page=` | `api/fields_page` | 1-based `page`, `page_size` 500, ordered by `field_id`; summary columns `null` until published |
| `GET /api/fields/:id` | `api/field_detail` | field properties + geometry, observations by time, summary |
| `GET /api/detectability` | `api/detectability` | `detectability.json` + `fixture` |
| `GET /api/checks` | `api/checks` | `checks.json` + `fixture` + `district` (= `district_check.json` or `null`; v1 addition: the Evidence page needs both) |
| `GET /api/provenance` | `api/provenance` | `provenance.json` + `fixture` |
| `POST /api/audit` | request `api/audit_request` → `api/audit_response` | body ≤ 5 MB, ≤ 5,000 claims, `budget` 1–500 |
| `GET /api/audit/:id` | `api/audit_response` | stored result |
| `GET /tiles/*` | bytes | R2 proxy, Range → 206 |

### Ranking (normative; core/rank.ts, Python `rules.rank`)

1. **Match** claims in input order. If `properties.field_id` names a field in the run, use it. Otherwise take
   the claim's point and use the field whose polygon contains it (smallest `field_id` if several do). A claim
   with neither is **unmatched**. `matched` and `unmatched` in the response count claims (two claims merged
   onto one field count twice).
   - **Claim point:** a `Point` is itself. For a polygon, take the part whose outer ring has the largest
     `|Σ (x_i·y_{i+1} − x_{i+1}·y_i)| / 2` over consecutive positions (planar lon/lat; strictly larger wins,
     so the first part wins ties). Average its vertices, closing vertex excluded. If that point is inside the
     outer ring, use it. Otherwise draw the horizontal line through it, collect the x where edges cross it
     (same edge test as below), sort ascending and use the midpoint of the first two.
   - **Containment:** inside the outer ring and inside no hole, where "inside a ring" is even-odd ray casting
     exactly as `(yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi`, toggled over every edge
     (j = previous index, starting with the last position). Points on edges therefore belong to exactly one
     of two neighbouring cells. Implementations MAY skip fields whose bounding box does not contain the point
     first (same result, much less CPU on the Worker).
2. **Candidates.** One per matched field (claims on the same field merge; `claimed` is the union and
   `claim_id` the first one) and one per unmatched claim.
3. **Weight.** Matched: the maximum over the claimed practices of
   - AWD by verdict: `inconsistent` 1.0, `not_enough_evidence` 0.6, `consistent` 0.1;
   - DSR by signal: `transplant_signal` 1.0, `unknown` 0.6, `dsr_signal` 0.1;
   - a field with no summary counts as 0.6.
   Unmatched: 0.8. **Score** = weight × area, where area is the field's `area_ha`, or for an unmatched claim
   its `area_ha` property if positive, else 1.0. (No trigonometry anywhere in ranking, so Python and
   TypeScript give identical scores.)
4. **Budget split.** `n = min(budget, candidates)`, `n_random = floor((n + 2) / 5)` (20%, rounded half up),
   `n_score = n − n_random`.
5. **Score picks:** sort by score descending, then weight descending, then key ascending (key = `field_id`,
   or `~` + `claim_id` for unmatched); take the first `n_score`.
6. **Random picks (stratified by district):** take the remaining candidates and group them by district
   (unmatched claims form the stratum `~unmatched`), with strata sorted by name. With integers only: each
   stratum gets `quota = floor(n_random × size / remaining)` and `rem = (n_random × size) mod remaining`;
   then strata sorted by `rem` descending (ties by name) each take one more pick while picks are left, never
   more than the stratum's size. With `rng = mulberry32(seed)`, visit
   the strata in order. Within each, sort by key and run `q` steps of Fisher–Yates
   (`j = i + floor(rng() × (m − i))`, swap `i` and `j`), taking the first `q`.
7. **Output** `ranked`: score picks in score order, then random picks in draw order, with `rank` = 1…n.
   `pick` is `score` or `random`. `reason` (exact text):
   - AWD part: `Not consistent with AWD ({d} of {looks} drained)` · `Not enough evidence for AWD ({looks})` ·
     `Consistent with AWD ({d} of {looks} drained)`; DSR part: `DSR: transplant signal` ·
     `DSR: signal unknown` · `DSR: DSR signal`; no summary: `No season summary yet`. Claimed parts are joined
     with `; ` in the order awd, dsr.
   - Unmatched: `Claim does not match a mapped rice field`.
   - Random picks are prefixed with `Random check; `.
8. **Ids and hashing.** `input_hash` = sha256 of the exact request body bytes. A missing `seed` is the first
   8 hex digits of `input_hash` read as a uint32. `audit_id` = `a_` + the first 16 hex digits of
   sha256(`run_id|input_hash|budget|seed`). The same body against the same run gives the same `audit_id` and
   the same ranking (T7). The ranking itself depends only on the parsed claims, `budget` and `seed`; only the
   ids depend on the exact bytes. So the app's in-browser sample ranking MUST pass an explicit `seed` and
   MUST NOT show an `audit_id` (it is not a stored audit). `synthetic` is true only if every claim is
   synthetic. `notice` is always `Ranking for inspection, not a finding about anyone.`

## B7. Wrangler

As SPEC B7. `run_worker_first: ["/api/*", "/tiles/*"]`; everything else is static assets with SPA fallback.

## B8. Sources

See SPEC B8 and DECISIONS.md. Every external number in a fixture or artifact names its URL in the file
itself (`param_sources`, `source_urls`, `gaps[].source`).

## B9. Fixtures (Lane 0)

`contracts/fixtures/` is generated by `python3 contracts/make_fixtures.py` (stdlib only, seed 20261114) and
committed:

- `run/`: a complete **published** run, `run_id = "fixture"`, every file with `"fixture": true`. Two tiles
  (Fazilka, Sri Muktsar Sahib), 300 fields (150 per tile), 12 passes (9 QP + 3 DH; 10 used, none in the gap;
  one excluded for direction, one as a duplicate UR product), all three verdicts and all three DSR signals,
  3 overlays of the hero tile (early, mid, late), `hist/{early,mid,late}.png`, `claims.sample.geojson` (60
  SYNTHETIC), `story.json`.
- `api/`: one response per endpoint, built from `run/`, including a golden `POST /api/audit` request and
  response.
- `live.json`: `{"v":1,"run_id":"fixture","fixture":true,"updated_at":"2026-11-14T00:00:00Z"}`.

`make fixtures-check` regenerates them in a temporary directory and fails if anything differs from the
committed copy.
