# Pipeline integration evidence — 2026-11-15

The shared source includes the previously deferred `177d6a6` geo-field work, applied
only to the pipeline and the still-needed portable CLI fixes against current main
`2d8b7c8`. Newer API shapes, scale work, site generation and publishing safeguards
remain in place. No live data was replaced by this integration.

## Published run and data boundary

`python platform/scripts/run_transfer.py fetch r01v1` fetched the
[`data-r01v1` release](https://github.com/volkthienpreecha/Mudskipper/releases/tag/data-r01v1)
into `artifacts/r01v1` and verified all 28 files against the release SHA-256 manifest.
`python contracts/validate.py artifacts/r01v1 --stage pipeline` reported zero errors
and zero warnings, including the run's listed artifact hashes and granule metadata.

| Property | Verified from the fetched artifacts |
|---|---|
| Run | `r01v1`, `fixture: false` (fixture property absent means false under the contract) |
| Fields | 5,000; all `source: grid`, provisional segment-derived geometries |
| Passes | 9 used / 12 listed; used passes are track 084 ascending, dual-pol HH/HV |
| Observations | 45,000; exactly one observation per selected field and used pass |
| Method | All `hhhv_v1`; unsupervised two-component Gaussian mixtures with July change features and optional equal-weight Sentinel-1 fusion |
| Flags | 45,000 provisional segment flags; 15,000 Sentinel-1-fused observations; 10,000 July-change flags |
| States | 21,936 flooded, 19,360 drained, 3,704 uncertain |
| Source revision | `64083c2ad0a34ad171ebe100cfd19ed416132120`, as supplied in provenance |

The run has GeoJSON fields and overlays/histograms but no `fields.pmtiles` or
`claims.sample.geojson`. Their API asset pointers are null. Sample claims must
either be shown as unavailable or generated explicitly as synthetic claims on
this run's field IDs through the geo writer; fixture claim IDs are not this run.

These are the published measurements and inferred states, not a fresh radar/model
rerun. The release contains no raw `.npz`/HDF5 inputs, `zonal.jsonl`, fitted-model
cache, Sentinel-1 scene list or raw decomposition cross-check. Its provenance
records subset hashes and a polsartools comparison, but this checkout cannot
independently reproduce those physical-input checks. In particular, the published
run is not a measured FTW-field run and contains no quad-pol observations.

The new `FieldUnits` path rasterizes the matching authoritative geo polygons,
preserves their identity/source/area/rice metadata, and rejects stale geometry
joins in classification, fusion, overlays, quad-pol comparisons and export. It
does not reassign these old segment measurements to FTW polygons. A future FTW
measurement run needs the matching actual radar acquisitions and subset caches.

## Local pipeline-to-API verification

The fetched run was preserved unchanged. A separate ignored copy,
`artifacts/r01v1-integration-check`, was used for downstream computation:

```powershell
node core/scripts/compute-run.ts artifacts/r01v1-integration-check
python geo/district_check.py --run-id r01v1 --run-dir artifacts/r01v1-integration-check
node core/scripts/compute-run.ts artifacts/r01v1-integration-check
python contracts/validate.py artifacts/r01v1-integration-check --stage published --recompute --quiet
node platform/scripts/build-bundle.ts --run artifacts/r01v1-integration-check --out artifacts/r01v1-api-check
node platform/scripts/build-site.ts --run artifacts/r01v1-integration-check --out artifacts/r01v1-site-check --placeholder
```

Node 24 and a Python environment with the documented dependencies were used. Core
produced 840 consistent, 321 inconsistent and 3,839 insufficient-evidence verdicts.
The global simulation used the existing parameters, seed `20261114`, and 4,000
simulations: `k_star = 3`, AWD catch probability 35%, continuous-flooding false
flag probability 4%. These are model-based scenario probabilities, not empirical
classifier accuracy. `core/src/params.ts` retains each cited or derived assumption;
the drained fraction is derived rather than directly measured in Punjab.

The district writer computed 4,493.00 ha of mapped rice and 2,746.32 ha of DSR
signal in Fazilka, and 4,342.68 ha / 2,378.48 ha in Sri Muktsar Sahib. A sampled
tile is not a district, and DSR signal is not proof of DSR.

Published-stage validation with `--recompute` passed with zero errors and warnings.
The resulting provenance lists 32 hashed artifacts. The API bundle contains 5,077
files and the isolated site contains 5,110 files, within the Pages limits.

The site was served locally using `wrangler pages dev` on port 8797 with local KV.
`node platform/scripts/smoke.ts --base http://127.0.0.1:8797 --expect-run r01v1`
passed all 24 checks: schemas, real-run flag, 5,000-field pagination/filtering,
9-observation field detail, tile Range/ETag handling, a synthetic audit round trip,
Markdown negotiation, real 404s and discovery pages. The shell was deliberately
the existing placeholder so this verifies the backend independently of ongoing
frontend work. It was not deployed to Cloudflare.

## Tests and reproducibility

The pinned offline environment is `pipeline/requirements-test.txt`. The pipeline
suite with `RUN_ID=r01v1` passed 24 tests and skipped four internal-input tests;
those require the absent original zonal/model and segment inputs. Synthetic
geometry/array tests cover holes, MultiPolygons, partial coverage, invalid
covariance masks, field-mean decomposition, deterministic field selection,
metadata-preserving writers and rejection of stale geometry. They establish
software behavior, not physical radar accuracy or Punjab ground truth.

The platform's run-transfer tests passed three cases using a fake GitHub CLI.
The full platform Node suite passed 114 tests across seven files, including local
D1 loading, fixture/API client parity and a real local Pages-runtime smoke test.
`platform/tsconfig.scripts.json` typechecking and the scoped Git whitespace check
also passed.
CLI tests exercise checkout paths with spaces, Windows/POSIX validator paths,
safe module imports, real fixture bundle/site creation and the Wrangler Node
entry point. Publisher subprocesses use uv/Python directly, and the wrapper uses
the current Node executable rather than an OS-specific shell shim.
