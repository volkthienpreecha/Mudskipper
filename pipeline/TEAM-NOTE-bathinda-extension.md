# Proposal: add a Bathinda extension tile (Ishaan, 2026-11-14)

**Short version:** keep Fazilka and Sri Muktsar Sahib exactly as the spec says. Add a third,
optional tile in Bathinda (still Punjab, and the spec's first fallback region) where two NISAR
satellite paths overlap, so fields there are seen every 6 days instead of every 12.

## Why
- NISAR's main path over us (track 084) passes every 12 days. A second path (track 156) also
  passes every 12 days, offset by 5 days, but it only covers land east of about 74.77° E.
- Fazilka and Muktsar are both west of that line, so they only get the 12-day view.
- In a trial tile inside the overlap strip:
  - fields caught drained at least once in canopy season: 50% (one path) -> 76% (both paths) [Bathinda tile]
  - fields caught drained at least twice: 25% -> 51%
  - labels from the two different paths, 5 days apart, agree 72–92% on most date pairs
    (an independent consistency check we cannot get anywhere else)

## What stays the same
- Primary study area, headline and DSR story: Fazilka + Sri Muktsar Sahib (spec A2).
- One CRID per series (P05023); each satellite path is classified separately.
- No data are invented; every pass maps to a real NASA granule.

## The extension tile
- `bathinda`: lon 74.82–74.98, lat 30.24–30.38 (~15 x 15 km). All corners reverse-geocode to
  Bathinda district, Punjab (OpenStreetMap). The first trial tile was moved south because it
  crossed into Faridkot.
- Track 084 + track 156, 18 used passes, Jun 25 – Oct 18.

## Needs from the team
- **Karthik:** OK to add `bathinda` to aoi.json as a third tile? Field-count cap (5,000) and the
  district table would need to cover it. Fine to keep it as "extension" in the UI only.
- **Volk:** possible story beat: "where the satellite looks twice as often, we catch 1.6x more drain events."

## Caveats
- Lower uncertainty in the trial area (8% vs 14%) is mostly the location, not the extra looks.
- All labels are INFERRED; there is no 2026 ground truth.

---
# Separate heads-up: July flood labels are weak (Ishaan)
- Checked our July radar labels against Sentinel-2 optical images taken 1 day later (standard rice flooding test).
- Radar says ~72% of fields flooded on Jul 14; optical says 32% (Fazilka) and 8% (Muktsar).
  We catch ~90–96% of optically flooded fields but also flag many dry ones. Agreement beyond chance (kappa) is 0.06–0.20.
- I tried calibrating on optical data from one district and testing on the other: it does not transfer
  (best cutoff differs by 3 dB between districts), so I did not adopt it. Better honest-weak than over-fitted.
- **Karthik (core/verdicts):** the DSR signal relies on "no flooding early". Because July over-calls flooding,
  DSR fields may get tagged transplant_signal. Suggest returning "unknown" unless early evidence is strong.
- **Update (v6):** Jul 14/26 now use a per-field "dropped 3 dB" rule on NISAR plus Sentinel-1 (free second radar), averaged. Agreement with optical is kappa 0.39 (Fazilka) and 0.46 (Muktsar), "moderate". Jul 2 remains weak.
- **Update (v7):** late-season drain now detected (Oct 18: 68% drained); Bathinda, never tuned, scores kappa 0.50 vs optical; Freeman–Durden matches polsartools exactly.
- **Volk / Limits box:** "Early-July flood labels agree only fairly with optical imagery."

---
# For DECISIONS.md (Ishaan's A4 review), paste-ready
| `drained_fraction_of_cycle` | 0.3 – 0.5 | derived | No source states the fraction directly. IRRI: non-flooded days per AWD cycle range from 1 to more than 10 ([IRRI AWD fact sheet](http://www.knowledgebank.irri.org/training/fact-sheets/water-management/saving-water-alternate-wetting-drying-awd)); a review reports the best schedule as ~3 days of drainage after ponded water disappears ([ARCC Agricultural Reviews R-2043](https://arccjournals.com/journal/agricultural-reviews/R-2043)). With `cycle_days` 4–10, ~2–3 dry days gives 0.3–0.5 (capped at 0.5, since PAU keeps fields ponded more often than dry). Keep at 0.3–0.5. |

# Other pipeline notes for DECISIONS.md
- Track 135 D DH (D-003) tested as run r02 and **not adopted**: first pass has no change baseline, only 3 canopy looks
  (Aug–Sep are quad-pol), Jul 17 kappa 0.12 vs optical, Oct 21 contradicted VIIRS fires (49% vs 94% drained). Main series = track 84 A.
- OPERA cross-check uses DSWx-S1 v1.0 (F-003 fallback): DSWx-NI not found over the tiles. 6 dates (Sep 22 – Oct 17), all ~0% water
  at 30 m under canopy, as expected; caveat in checks.json note.
- Contract run: artifacts/r01v1 passes `validate.py --stage pipeline` with 0 errors, including checks.json.
