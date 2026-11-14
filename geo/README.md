# geo/ — tiles, fields, district table, sample claims

**Owner:** Karthik · **Language:** Python · **Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) steps 1, 3, 6

| Script | Writes (contract) | Gate |
|---|---|---|
| `grid.py` | `aoi.json` (B3.1) + labeled 40 m grid `fields.geojson` (B3.3, `source: grid`) | H+0:45 |
| `fields.py` | FTW polygons → rice mask → ≥ 0.5 ha → ≤ 5,000 fields; `fields.geojson` + `fields.pmtiles` | H+3 |
| `district_check.py` | `district_check.json` (B3.7) | Day 2 |
| `claims_sample.py` | `claims.sample.geojson` (B3.12, 60 SYNTHETIC claims) | Day 2 |

Not started yet. Lane work begins after `v0-foundation`.
