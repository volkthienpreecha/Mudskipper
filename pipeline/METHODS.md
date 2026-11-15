# Mudskipper pipeline: methods, validation, limits (Ishaan, 2026-11-14)

## What it produces
`artifacts/<run>/observations.jsonl`: one row per field per NISAR pass, with `flooded`, `drained` or `uncertain`
(B3.4 schema, method `hhhv_v1`). Also `passes.json` (B3.2), `provenance.json` (B3.9) and `overlays/` (B3.10).
Run r01: Fazilka + Sri Muktsar Sahib, NISAR track 084, 9 passes from Jul 2 to Oct 18 2026, about 24k fields,
218,493 observations.

## Data
- NISAR L2 GCOV, CRID P05023, dual-pol HH/HV at 10 m (ASF / Earthdata). Quad-pol track 135 is used only as a check.
- Sentinel-1 RTC VV/VH (Microsoft Planetary Computer): second radar for July only.
- Sentinel-2 L2A (Element84): **validation only, never used to train or tune.**
- ESA WorldCover 2021 cropland mask. Fields are provisional Felzenszwalb segments (0.5–100 ha) until geo/ fields.geojson lands.

## How a label is made
1. Each field's pixels are averaged in linear power, then converted to dB.
2. **Jul 2:** a 2-group Gaussian mixture on HH/HV, fit on all July passes. Darker HH means open water.
3. **Jul 14 and Jul 26:** the field's own HH drop since Jul 2. A drop of 3 dB or more means flooded, under 2 dB means drained.
   The same rule is applied to Sentinel-1 VV within 2 days, and the two probabilities are averaged.
   The rule is self-referenced, so district brightness offsets cancel. The thresholds are the standard 3 dB SAR change value and were not fit.
4. **Aug–Oct (canopy):** L-band sees water-stem double bounce, so flooded fields are bright. Features are each field's
   drop below its own season level, and one mixture model is fit per track.
5. **Uncertain** if valid pixels are under 60% or 0.35 < p_flooded < 0.65 (B3.4). Fields that never look like rice are flagged `not_rice_like`.

## Validation (no 2026 ground truth exists, so several independent checks)
| Check | Result |
|---|---|
| Canopy model: 2 groups really exist (BIC gain) | 83,026 (strong) |
| Canopy model: refit with other seeds / half the data | 100% / 100% same labels |
| Fit on one district, apply to the other | 100% agreement (canopy), 76–83% (July mixture) |
| Two NISAR tracks 5 days apart (Bathinda extension tile) | 72–92% agreement |
| Sentinel-2 optical flooding (Xiao 2005), Jul 14 | kappa 0.39 Fazilka, 0.46 Muktsar (moderate) |
| Sentinel-2 optical, Jul 2 | kappa about 0.05 (weak) |
| Quad-pol Freeman–Durden double bounce vs canopy labels | AUC 0.58 (weak, field-scale) |
| Unit tests (physics, gap exclusion, schema, determinism) | 9/9 pass |

Kappa is reported instead of plain accuracy, because most fields are dry and "all dry" would score about 90%.

Rejected on purpose (overfitting): a logistic model trained on optical labels (did not transfer between districts),
scene-normalised July features (high stability but wrong flood shares), and per-district cutoffs.

## Limits (text for the app)
- All labels are **inferred** from satellite radar. No 2026 field visits exist to confirm them.
- Early-July (Jul 2) flood labels agree only weakly with optical imagery. Mid/late-July labels agree moderately.
- Canopy-season labels show each field's change relative to its own season. They are reliable as a pattern and approximate per pass.
- NISAR passes every 12 days and has a data gap from Jul 27 to Aug 10 2026, so short drain events can be missed.
- Fields are provisional image segments, not cadastral plots.
- Provisional NISAR HV calibration jumps ~5 dB between some passes in Bathinda, so HV-based features are less reliable there.
- The rice filter likely lets some cotton fields through in Fazilka, which inflates "no early water" there.
- Direct-seeded vs transplanted calls depend on early flooding evidence, so treat them as indicative.

## What would make it better
- Real field boundaries from geo/ (rasterise fields.geojson in zonal.py).
- A handful of ground photos or farmer reports per district. This is the only thing that turns "inferred" into "validated".
