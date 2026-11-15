# pipeline/ state (Ishaan's lane) — integration update 2026-11-15

The geo-field integration and offline CI are consolidated into the shared source.
Published `r01v1` was fetched through the checksum-verifying release transfer and
passed the pipeline contract validator: 5,000 grid fields, 9 used passes, 45,000
observations. Core/district computation and API bundling use a separate local copy.
See [INTEGRATION.md](INTEGRATION.md) for commands, evidence and remaining input limits.

The following notes are historical; their empty-repository and uncommitted-work
statements describe the original lane checkout.

Spec: `C:\Users\lingi\Downloads\Mudskipper (NASA) Specs.pdf` (LANE ISHAAN, Part C; contracts in Part B).
Team repo is still EMPTY (Karthik's Lane 0 not pushed): no docs/SPEC.md, contracts/, aoi.json, fields.geojson, DECISIONS.md.
Nothing is committed. Team rules: own git identity, NO AI co-author lines, commit only inside pipeline/.

## Run it (from repo root, Windows)
```
.venv\Scripts\python.exe pipeline\search.py        # passes.json        (no login needed)
.venv\Scripts\python.exe pipeline\fetch.py         # data\<pass>_<tile>.npz   (Earthdata login in ~/_netrc)
.venv\Scripts\python.exe pipeline\landcover.py     # data\landcover_<tile>.npz (ESA WorldCover cropland)
.venv\Scripts\python.exe pipeline\segments.py      # data\segments_<tile>.npz  (provisional fields)
.venv\Scripts\python.exe pipeline\zonal.py         # artifacts\r01\zonal.jsonl
.venv\Scripts\python.exe pipeline\classify.py      # artifacts\r01\observations.jsonl + hist\ + classify_summary.json
.venv\Scripts\python.exe pipeline\overlays.py      # overlays\, quicklook_<tile>.png, zoom_<tile>.png
$env:PYTHONPATH="pipeline"; .venv\Scripts\python.exe pipeline\qp_check.py   # quad-pol check
```
`RUN_ID` env var picks the artifacts folder (default r01). `ONLY_TILE` limits landcover/segments/zonal to one tile.

## Decisions made (to log in DECISIONS.md when it exists)
- Series: dual-pol (DH), track 084 ascending, frame 017, CRID P05023 -> 9 used passes, Jul 2 – Oct 18.
  Quad-pol exists only for 4 passes (track 135 D, Aug 22 – Sep 27) -> used as a side check, not the main series.
- p20260620 excluded: radiometric outlier (tile HH median ~+14 dB; all other passes -4..-16 dB). Cause unknown.
- Track 156 (ascending, DH) does NOT cover the current tiles; valid swath starts ~74.77 E at 30.4 N.
  Both tracks overlap ~74.77–75.32 E (mostly Bathinda). Trial run x01 tests a tile there (see below).
- Tiles are PROVISIONAL (fetch.py TILES): fazilka 73.95,30.33,74.11,30.47; muktsar 74.44,30.40,74.60,30.54.
- Fields are PROVISIONAL: Felzenszwalb segments of the HH/HV time series (segments.py), ~12k per tile, median 1.4 ha.
  Over the 5,000-field cap. zonal.py refuses to run if artifacts/<run>/fields.geojson exists (rasterising it is a TODO).
- Non-cropland removed with ESA WorldCover 2021 class 40 (stand-in for geo's rice mask).
- Classifier (classify.py v4, method hhhv_v1), one model per track:
  - open regime (before Aug 1): GMM on absolute hh_db, hv_db; flooded = lower HH.
  - canopy regime (after the gap): GMM on each field's drop below its own bright level; flooded = at own level.
  - fields never within 3 dB of the scene's bright level in canopy season -> uncertain + flag not_rice_like.
  - spec's early/mid boundary (Jul 15) is kept for the `stage` field only; the regime switch is Aug 1.

## Results so far (r01, INFERRED, no ground truth)
- 218,493 observations; overall 63% flooded / 22% drained / 14% uncertain.
- July looks right on the maps (12% flooded Jul 2 -> 65% Jul 14). Canopy season weakly supported:
  quad-pol double-bounce check AUC 0.58 (3 days apart, so a coarse check).
- Known weaknesses: canopy "flooded" is the default (a field drained all season is missed);
  hand-set numbers (Aug 1, -3 dB, segment scale) were chosen on these two tiles only.
- An earlier "AUC 0.91" result was INVALID (it measured town vs farmland). Do not quote it.

## Done since
- provenance.py -> artifacts/<run>/provenance.json (decomposition_check still null)
- pipeline/tests/test_pipeline.py: 9 tests pass (`.venv\Scripts\python.exe -m pytest pipeline	ests -q`)
- evaluate.py -> evaluation.json (r01): canopy model BIC gain 83k, silhouette 0.54, 100% stable across seeds,
  halves and district transfer. Open-water model: BIC gain 8.3k, silhouette 0.40, 100% seed/half stable,
  but district transfer only 76% (fazilka->muktsar) / 83% (muktsar->fazilka): ~1 in 5 early labels depends
  on which district the model was fitted on.

## Not done (spec items)
- polsartools/PyPolSARpro cross-check of freeman_durden.py (max_abs_diff_db)
- Sentinel-2 water index + OPERA DSWx agreement (independent sensors)
- checks.py (season shape, OPERA), docs/METHODS.md, Limits text
- passes.json fields still empty: covariance_terms, pixel_m, valid_fraction_by_tile
- fd_gmm_v1 on the 4 quad-pol dates; rasterise real fields.geojson when Karthik ships it

## Ricemapper (Microsoft, MIT) — cloned at C:\Users\lingi\Documents\Mudskipper-ext\ricemapper, not run
Ships trained AWD and DSR models, but they need Sentinel-1 season time series + Presto embeddings (~6k features).
Season-level labels only (AWD vs CF, DSR vs PTR); cannot label a single date. AWD model needs data to Dec 15.
Its data/Comparison-Govt-Pred.csv has 2024 district numbers for Fazilka and Sri Muktsar Sahib.

## Spoken updates
User likes key updates read aloud: `C:\Users\lingi\Documents\Mudskipper-ext\say.ps1 -Text "..."`
(edge-tts, voice en-GB-ThomasNeural, rate -5%, pitch -10Hz). Short, plain sentences.

## Overlap trial x01 (done) — tile "overlap" 74.82,30.38,74.98,30.52, tracks 084 + 156, 18 passes
Run: `$env:RUN_ID="x01"; $env:ONLY_TILE="overlap"` then landcover/segments/zonal/classify.
- Uncertainty: 7.7% overall, but 8.2% with track 084 alone, so the drop vs 14% is mostly the location, not the extra looks.
- Real gain from 2 tracks: fields caught drained at least once in canopy season 43% -> 68%; at least twice 24% -> 45%.
- Independent check: labels from the two different satellite paths 5 days apart agree 80–93% on most date pairs.
  Low pairs: Jul 26 -> Aug 12 (33%, spans the data gap and the regime switch) and Aug 31 -> Sep 12 (67–68%).
- Location likely Bathinda (not checked against district boundaries). Moving a study tile is a TEAM decision.

## Over-fitting / normalisation trap (checked, rejected)
- Open-water model with scene-relative features (value minus each scene's q50/q75/q90) scores ~99% district
  transfer, BUT it flattens the real season signal: Jul 2 flooded share goes 12% -> 53% (same as Jul 14/26).
  It "transfers" only because every scene is forced to look alike. Kept absolute dB features (76–83% transfer).
- Same caution applies to the canopy model: its features are relative to the scene q75 AND to each field's own
  q75, so part of its 100% stability is by construction. Canopy labels mean "darker than this field's usual
  canopy-season level", not an absolute flooded/drained measurement. Say this in Methods/Limits.

## Optical check (optical_check.py, Sentinel-2 L2A via Earth Search, Xiao et al. 2005 rule) — IMPORTANT
- Only valid in early season: once the canopy closes, optical sensors cannot see water under the plants
  (all Aug–Oct comparisons show ~0% optical flooding; ignore them, the check is not applicable there).
- July results (S2 1 day after NISAR Jul 14, cloud < 1%):
    fazilka: optical 33% flooded vs NISAR 72%; NISAR catches 90% of optical-flooded fields (recall) but
             only ~42% of NISAR "flooded" are optically flooded (precision); kappa 0.20–0.22 (fair)
    muktsar: optical 8.5% vs NISAR 72%; recall 0.96, precision 0.11, kappa 0.06 (slight)
- Meaning: the open-water model OVER-CALLS flooding in July. Likely cause: dark L-band HH also comes from
  smooth bare/wet soil and sparse young crops, not only standing water. Muktsar (a big DSR district: dry-seeded,
  not flooded early) shows the largest gap, which fits.
- Possible fix (needs team OK, it changes the spec's purely unsupervised method): calibrate the open-water
  threshold on optical labels from ONE tile, test on the OTHER tile (honest held-out test).

## Bathinda extension (run "ext", done) — tile bathinda 74.82,30.24,74.98,30.38, tracks 084+156, 18 passes
Run: `$env:RUN_ID="ext"; $env:ONLY_TILE="bathinda"` then landcover/segments/zonal/classify/overlays/provenance.
- 12,491 segment fields; 8.1% uncertain overall.
- drained >=1 in canopy season: 50% (track 084 only) -> 76% (both tracks); >=2: 25% -> 51%.
- cross-track agreement 5 days apart: 72–92% on most pairs (42% across the data gap; 67% around Sep 5).
- Maps: artifacts/ext/quicklook_bathinda.png, zoom_bathinda.png. Team note: pipeline/TEAM-NOTE-bathinda-extension.md

## Optical calibration attempt (calibrate.py) — tried, NOT adopted
Training labels: Sentinel-2 Xiao rule per field (optical_fields.jsonl): fazilka Jul 14 32% wet, muktsar Jul 14 8% wet,
fazilka Jul 2 10% wet. Held-out tests (never trained on the test district/date):
- Radar does carry signal: optical-wet fields are 1–3 dB darker in HH; AUC 0.68–0.79 (0.5 = chance).
- But nothing transfers well between districts:
  - logistic regression: fazilka->muktsar kappa 0.26 (better than GMM 0.06), muktsar->fazilka kappa 0.00 (predicts no flooding)
  - best HH cutoff is -13.0 dB in fazilka but -16.25 dB in muktsar (3 dB apart); kappa 0.13–0.36 either way
  - high "agreement %" numbers are the accuracy trap (most fields are dry); kappa/F1 are the honest scores
- Decision: keep the unsupervised GMM (no per-district tuning that would not survive a new district).
  Report July skill honestly: kappa vs optical 0.06 (muktsar) to 0.20 (fazilka) on Jul 14; it over-calls flooding.
- Consequence for core/ verdicts: the DSR signal relies on "no early flooding", so July over-calling will push
  dry-seeded fields toward "transplant_signal" (DSR undercount). Tell Karthik; consider dsr signal "unknown"
  unless early evidence is strong.
- Caveat: the optical rule is not ground truth either (it can miss water under early canopy, and DSR fields are moist).

## v5 July fix: self-referenced change rule (2026-11-14)
- Jul 14 and Jul 26 are now labelled by the field's HH drop below its own Jul 2 value: >= 3 dB flooded,
  < 2 dB drained, in between uncertain (standard 3 dB SAR change threshold; nothing fit to optical).
  Jul 2 still uses the July GMM (no earlier clean baseline; Jun 20 is a radiometric outlier).
- Flag `hh_change_vs_jul2` marks these rows; the method stays `hhhv_v1` (B3.4 contract).
- Jul 14 vs optical: Fazilka kappa 0.20 -> 0.34, Muktsar 0.06 -> 0.23; flooded share 64% -> 24%
  (optical 32% / 8%). Jul 2 is still weak vs optical (kappa ~0).
- Rice mask (not_rice_like) and season-context features were tested and gave almost no gain; not used.
- Next ideas: Sentinel-1 VV as a second sensor; season HMM smoothing.

## v6: Sentinel-1 fused into early season (2026-11-14)
- `pipeline/s1_fields.py` pulls Sentinel-1 RTC (Microsoft Planetary Computer, anonymous) for Jun 15 – Aug 1,
  warps VV/VH onto the field grid, writes artifacts/<run>/s1_fields.jsonl. Run: `PYTHONPATH=pipeline python pipeline/s1_fields.py`.
- classify.py: for each pre-Aug NISAR pass, S1 scenes within 2 days get the same untuned 3 dB VV-drop rule
  (each orbit vs its own earliest scene); p_flooded = mean(NISAR p, S1 p). Flag `fused_sentinel1`. Method stays hhhv_v1.
- Jul 14 vs optical (kappa): Fazilka 0.20 -> 0.34 (v5) -> 0.39; Muktsar 0.06 -> 0.23 -> 0.46. Flooded share 11–13% (optical 8–32%).
- Jul 2 still weak (kappa 0.05): no clean pre-flood NISAR baseline. Stopped tuning here to avoid fitting to optical.
- TODO: list S1 scene IDs in provenance.json.

## Handoff ready (2026-11-14)
- `Mudskipper-pipeline-handoff.zip` (repo root, 10 MB): pipeline/ code + artifacts/r01 outputs (large intermediates left out).
- `pipeline/METHODS.md`: methods, validation table, Limits text for Volk, what would make it better.
- provenance.json now lists the 13 Sentinel-1 scenes + Sentinel-2/WorldCover sources.
- Waiting on team: Karthik's git repo (then commit pipeline/ only) and fields.geojson; ground photos if anyone can get them.

## In progress (2026-11-14, usage limit hit)
- DONE: pipeline/fill_passes.py fills passes.json covariance_terms/pixel_m/valid_fraction_by_tile (TILES env, default fazilka,muktsar). Run after fetch.
- DONE: pipeline/checks.py -> checks.json. Results: schema PASS, harvest PASS, early_low PASS, flip_rate PASS (2.8%),
  never_drained_late WARN: 64% of rice-like fields stay "flooded" on both Oct passes (expect drain before harvest).
  Likely cause: canopy labels are relative to each field's own season, so late senescence isn't read as drained. Investigate, and add it to Limits.
  Also note: after S1 fusion, July flooded shares are 2–9%, below optical's 10–32% (fusion is conservative).
- TODO: tests for fill_passes/checks; Freeman–Durden vs polsartools (provenance decomposition_check);
  rerun Bathinda (RUN_ID=ext) with v6 + optical_check; refresh handoff zip; add these to METHODS.md.

## Done after reset (2026-11-14)
- Tests: 12 (added passes fields, checks.json, provenance S1). Pass for r01 and ext.
- Freeman–Durden: added PolSARpro-style realizability conditioning; now matches polsartools 0.13 exactly
  (fd_crosscheck.py, 156,732 px, max 0.000 dB) -> provenance decomposition_check. polsartools installed --no-deps (GDAL not needed).
- v7 canopy reference: scene q75 follows growth up to the season HH peak, then held at the peak, so the Oct 18 pre-harvest drain shows
  (r01 Oct 18: 68% drained; checks all PASS). BIC gain 83k -> 130k, seeds/halves/transfer still 100%. QP AUC 0.58 -> 0.56.
- Peak chosen by HH, not HH/HV: provisional HV jumps ~5 dB between passes in Bathinda.
- Bathinda (ext) rerun with v7 + S1: optical kappa 0.65 / 0.53 (Jun 25/27), 0.30 (Jul 14), pooled 0.50. never_drained_late WARN
  only because track 156's single Oct look (Oct 11) precedes the drain.
- Remaining: Karthik's fields.geojson + git; ground photos.

## Real-world checks (2026-11-14)
- firms_fetch.py: VIIRS 375 m active fires (VNP14IMG/VJ114IMG/VJ214IMG v002 via earthaccess, no FIRMS key), 459 granules,
  155 nominal/high-confidence detections -> artifacts/firms_fires.jsonl. firms_check.py -> artifacts/<run>/firms_check.json.
  r01: burned fields 93.7% drained on Oct 18 vs 84.8% unburned (z~3.8). ext/Bathinda: 56.9 vs 59.6 (no signal).
  Timing test has low power (fires ~3 weeks after the last pass, when nearly all fields are drained).
- artifacts/dsr_official_check.json: official DSR share (2023-24) vs our no-early-water share. Bathinda 8 vs 7.6 (match);
  Fazilka/Muktsar order reversed (likely cotton passing the rice filter). No 2026 district figures published yet.

## Contract v1 + GitHub (2026-11-14)
- Team repo: github.com/volkthienpreecha/Mudskipper. Contracts on branch docs/decisions-readme (validator: contracts/validate.py).
- pipeline/export_contract.py r01 r01v1 -> artifacts/r01v1 in contract format (ids fazilka-00123 / 20260702-T084A,
  5,000-field random sample, north-up overlays, hist/<stage>.png). validate.py --stage pipeline: 0 errors.
- Pushed branch ishaan/pipeline-v1 (commit ecb4fcf). Data never goes in git: Karthik gets artifacts/r01v1 via the zip / make publish.
- Open with team: (1) aoi.json tile boxes differ from ours (fixture fazilka 74.042-74.198/30.262-30.398); if geo/ keeps
  those, refetch on them. (2) D-003 says track 135 D has 6 DH passes over our tiles: add as second series.
  (3) fields source "grid" used for our segments (enum has no "segments"). (4) Jun 20 radiometric outlier mapped to
  excluded_reason "processing_failed".

## Session end (2026-11-14, later)
- Track 135 DH tried as r02 (fetched, data/ cached) -> rejected, see search.py comment + TEAM-NOTE. Code kept: per-track change
  baseline, MIN_CANOPY_LOOKS=4, `no_change_baseline` (track first pass w/o Sentinel-1 -> uncertain), zonal TILES env.
- opera_check.py (DSWx-S1) -> artifacts/r01/opera_pairs.json; export_contract.py now writes checks.json (B3.8) and a fixed created_at.
- r01v1 re-exported; validator 0 errors. drained_fraction_of_cycle: derived 0.3–0.5, paste-ready row in TEAM-NOTE.
- Karthik has NOT started geo/ (only README). Our segments ship as fields (source "grid") until FTW fields exist.

## Rice mask + reliability (2026-11-14, latest)
- ricemask.py: per-field rice share from the 2024 North India 30 m paddy map (Zenodo 21349862, range reads only)
  -> artifacts/<run>/rice_prior.jsonl. classify.py: fields < 0.5 rice get `not_rice_2024`, are not labelled and not fit.
  Rice fields only: uncertain 16.1%, Jul 14 kappa Fazilka 0.38 / Muktsar 0.49, transfer 80/88%, Bathinda pooled 0.52.
- reliability.py: agreement with optical rises with confidence (73 -> 85 -> 90%); Muktsar top band kappa 0.69.
- Rejected: May S1 baseline (s1_fields_may_rejected.jsonl kept), HMM smoothing. No pre-season track 84 NISAR passes exist.
- Fixed: export_contract area/crop_frac off-by-one; provenance lists every pass (main's stricter T3). Validator 0 errors.
