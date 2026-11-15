# pipeline/ — radar to per-field states

**Owner:** Ishaan · **Language:** Python · **Prompt:** [SPEC Lane Ishaan](../docs/SPEC.md#lane-ishaan-ml--radar-pipeline)

Single deliverable: a correct `artifacts/<run_id>/observations.jsonl`. Everything downstream depends on it.

| You read | You write (contract) |
|---|---|
| `aoi.json`, `fields.geojson` from geo | `passes.json` (B3.2), `observations.jsonl` (B3.4), `overlays/` + `hist/` (B3.10), `provenance.json` (B3.9), `checks.json` (B3.8, Day 2) |

Before you start:

- **Published run:** `r01v1` contains 5,000 provisional grid/segment fields, 9 used dual-pol
  track-084 ascending passes and 45,000 observations. The original coverage searches in
  [DECISIONS.md D-003](../DECISIONS.md) also considered other tracks and quad-pol;
  they are not the inputs of this published run. See [INTEGRATION.md](INTEGRATION.md).
- The A6 snippet needs `t[2] == "PR"` and a dedupe: ASF also lists UR products and mixed-mode splits for the
  same acquisition ([DECISIONS.md F-002](../DECISIONS.md)).
- The uncertain rule, `confidence`, stages, flags and the method-per-pol-mode rule are exact in
  [CONTRACTS.md B3.4](../contracts/CONTRACTS.md#b34-observationsjsonl-one-line-per-field-per-used-pass).
- Check your output at any time (stage `pipeline` skips core's files):

  ```sh
  make setup
  .venv/bin/python contracts/validate.py artifacts/r01 --stage pipeline
  ```

- Parameters and assumptions (SPEC A4): the table in [DECISIONS.md](../DECISIONS.md#parameters-and-citations-for-ishaans-review-spec-a4)
  and [`core/src/params.ts`](../core/src/params.ts). All are cited, derived or conventions;
  `drained_fraction_of_cycle` is derived, not directly measured in Punjab.

The lane is implemented. `STATE.md` and older results describe Ishaan's provisional
segment runs; those measurements do not belong to the FTW field boundaries.

Geo integration now prefers the matching `artifacts/<run>/aoi.json` and
`fields.geojson` handoff. `zonal.py` projects the WGS84 polygons onto each cached
radar grid, including holes and MultiPolygons, and retains their field IDs,
source, area and rice fraction. Geo coverage uses all pixel centres in the field,
including centres outside a partial raster window. It does not borrow the old
segment/WorldCover mask. Without `fields.geojson`, the previous segment path stays
available and is flagged `provisional_segment_fields`.

The internal observations carry a hash of each source feature. Classification,
Sentinel-1 fusion, overlays and contract export reject a stale geometry join;
reusing the same ID from a different handoff cannot attach its old measurements.
Quad-pol statistics average valid covariance terms (including HV/VH where
available) in linear power before Freeman–Durden decomposition. The classifier's
thresholds and uncertainty rules are unchanged.

For a real run, place the matching geo handoff and the actual acquisition list in
`artifacts/<run>/`, then acquire the radar subsets for that AOI using the existing
Earthdata setup. Copying old segment observations beside new polygons is invalid.
The following steps run from the repository root after the physical inputs exist:

```powershell
$env:RUN_ID = "r02"
python pipeline/fetch.py       # actual radar subsets; requires authorized Earthdata access
python pipeline/zonal.py
python pipeline/classify.py
python pipeline/overlays.py
python pipeline/provenance.py
python pipeline/export_contract.py r02 r02v1
python contracts/validate.py artifacts/r02v1 --stage pipeline
```

`fetch.py` is a network operation; the tests below do not run it. A geo handoff
alone has no passes or radar measurements, and zonal aggregation fails explicitly
when those inputs are missing. Do not run `segments.py` or `ricemask.py` to replace
the authoritative geo identities/rice fractions. Optional `s1_fields.py` and
`qp_check.py` also use the selected geo identities and require their real scene
inputs; rerun any old segment ancillary caches before fusion.

Export retains all observed geo fields when the total is within the 5,000-field
contract limit. Larger runs and the segment fallback use the deterministic tile
sample; `field_selection.json` records every selected and excluded ID. Geo
geometry, area, source and rice fraction are copied exactly. Overlay pixels are
masked to that selection. PMTiles are not copied across a sampled export: rebuild
them from the exported GeoJSON through the geo lane before publishing when needed.
Export requires source subset checksums, a real source revision and a source
creation time; it does not manufacture those values. Incomplete independent
checks remain unverified, and the existing contract validator is still the gate.

Run the offline tests in an isolated environment:

```powershell
uv venv .venv-pipeline --python 3.12
uv pip install --python .venv-pipeline/Scripts/python.exe -r pipeline/requirements-test.txt
.venv-pipeline/Scripts/python.exe -m pytest pipeline/tests -q --basetemp artifacts/pipeline-test-temp
```

The synthetic tests cover pixel/ID mapping, holes and multipart geometry, partial
coverage, invalid covariance values, field-mean decomposition, segment fallback,
metadata-preserving writers, and the field cap/selection manifest. Artifact tests
skip when the real run is absent. Passing them does not validate physical radar
results, field labels or a live deployment.

To include the exported run's read-only artifact checks, set `$env:RUN_ID = "r01v1"`
before pytest. Internal classifier reruns still skip unless `zonal.jsonl` exists;
the downloaded contract export does not contain its raw radar or internal caches.
