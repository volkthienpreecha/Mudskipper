# app/ — what judges see

**Owner:** Volk · **Stack:** Vite + TypeScript, MapLibre GL JS, PMTiles, hand-built SVG charts ·
**Prompt:** [SPEC Lane Volk](../docs/SPEC.md#lane-volk-frontend--ui--page--video-app) and [WIN_GUIDE](../docs/WIN_GUIDE.md)

Data only ever comes through `core/client.ts` (never `fetch` directly). Until it lands, these files show the
exact shapes you will receive:

| Screen | Response example (`contracts/fixtures/api/`) | Schema (`contracts/schemas/api/`) |
|---|---|---|
| Story | `story.json`, `meta.json` | `story`, `meta` |
| Map | `meta.json` (asset URLs), `passes.json`, `fields.json`; GeoJSON in `run/fields.geojson`, overlays in `run/overlays/` | `meta`, `passes`, `fields_page` |
| Field card | `field.<id>.json` | `field_detail` |
| Lab | `detectability.json` (`params`, `param_sources`, `results.*.dist`, `sentence`) | `detectability` |
| Scarecrow | `audit.request.json` → `audit.response.json`; sample claims in `run/claims.sample.geojson` | `audit_request`, `audit_response` |
| Evidence | `checks.json` (season shape, OPERA, district table), `provenance.json` | `checks`, `provenance` |

- `fixture: true` on any response → show the **SAMPLE DATA** badge (T8). `synthetic: true` claims → **SYNTHETIC**.
- Evidence tag for every number: [`contracts/evidence_tags.json`](../contracts/evidence_tags.json) (T12).
- Limits box text: `meta.limits_text` (identical to SPEC D8).
- Words: "consistent with AWD", "not consistent with AWD", "not enough evidence", "clear looks",
  "satellite evidence". Never "fraud", "cheating" or "proof of" (SPEC D5).

Not started yet. Lane work begins after `v0-foundation`.
