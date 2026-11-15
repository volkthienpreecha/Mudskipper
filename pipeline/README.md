# pipeline/ — radar to per-field states

**Owner:** Ishaan · **Language:** Python · **Prompt:** [SPEC Lane Ishaan](../docs/SPEC.md#lane-ishaan-ml--radar-pipeline)

Single deliverable: a correct `artifacts/<run_id>/observations.jsonl`. Everything downstream depends on it.

| You read | You write (contract) |
|---|---|
| `aoi.json`, `fields.geojson` from geo | `passes.json` (B3.2), `observations.jsonl` (B3.4), `overlays/` + `hist/` (B3.10), `provenance.json` (B3.9), `checks.json` (B3.8, Day 2) |

Before you start:

- **Coverage is probably already answered:** see [DECISIONS.md D-003](../DECISIONS.md). Over both tiles the
  season is HH/HV on two tracks, with quad-pol on 4 descending passes (Aug 22 – Sep 27). Please confirm with
  the A6 check on the real tiles.
- The A6 snippet needs `t[2] == "PR"` and a dedupe: ASF also lists UR products and mixed-mode splits for the
  same acquisition ([DECISIONS.md F-002](../DECISIONS.md)).
- The uncertain rule, `confidence`, stages, flags and the method-per-pol-mode rule are exact in
  [CONTRACTS.md B3.4](../contracts/CONTRACTS.md#b34-observationsjsonl-one-line-per-field-per-used-pass).
- Check your output at any time (stage `pipeline` skips core's files):

  ```sh
  make setup
  .venv/bin/python contracts/validate.py artifacts/r01 --stage pipeline
  ```

- Parameters to review (SPEC A4): the table in [DECISIONS.md](../DECISIONS.md#parameters-and-citations-for-ishaans-review-spec-a4).
  One still needs a source: `drained_fraction_of_cycle`.

Not started yet. Lane work begins after `v0-foundation`.
