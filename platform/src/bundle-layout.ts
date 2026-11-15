/**
 * Layout of the static API bundle inside the deployment (written by scripts/build-bundle.ts, read by
 * src/repo/static.ts). `/data/` mirrors the R2 layout of SPEC B5 (`live.json`, `runs/<run_id>/…`), so the
 * same /tiles/<key> maps to R2 key `<key>` or to asset `/data/<key>`.
 *
 *   /data/live.json                              which run is live (CONTRACTS.md live.json)
 *   /data/runs/<id>/manifest.json                BundleManifest: docs present, tile files with size + sha256
 *   /data/runs/<id>/api/<doc>.json               meta, story, passes, detectability, states, checks, provenance
 *   /data/runs/<id>/api/fields.json              every field row (the Function filters and pages)
 *   /data/runs/<id>/api/fields/<field_id>.json   one GET /api/fields/:id response per field
 *   /data/runs/<id>/api/summaries.json           field_summary lines as one array (ranking input)
 *   /data/runs/<id>/<path>                       raw run files for /tiles (fields.geojson, overlays/…, hist/…)
 */
import type { DocName } from "./contracts.ts";

export const DATA_PREFIX = "/data";
export const LIVE_PATH = `${DATA_PREFIX}/live.json`;

export const runRoot = (runId: string) => `${DATA_PREFIX}/runs/${runId}`;
export const manifestPath = (runId: string) => `${runRoot(runId)}/manifest.json`;
export const docPath = (runId: string, name: DocName) => `${runRoot(runId)}/api/${name}.json`;
export const fieldRowsPath = (runId: string) => `${runRoot(runId)}/api/fields.json`;
export const fieldPath = (runId: string, fieldId: string) => `${runRoot(runId)}/api/fields/${fieldId}.json`;
export const summariesPath = (runId: string) => `${runRoot(runId)}/api/summaries.json`;
export const tilePath = (runId: string, rel: string) => `${runRoot(runId)}/${rel}`;

/**
 * Raw run files that /tiles serves (CONTRACTS.md B3, SPEC B5): the map layers, overlays, histograms and the
 * sample claims. Matched against run-relative POSIX paths.
 */
export function isTileFile(rel: string): boolean {
  return (
    rel === "fields.geojson" ||
    rel === "fields.pmtiles" ||
    rel === "claims.sample.geojson" ||
    /^overlays\/[^/]+\.(png|json)$/.test(rel) ||
    /^hist\/[^/]+\.png$/.test(rel)
  );
}

const TYPES: Record<string, string> = {
  geojson: "application/geo+json",
  json: "application/json; charset=utf-8",
  png: "image/png",
  pmtiles: "application/octet-stream",
  jsonl: "application/x-ndjson",
  webp: "image/webp",
};

export function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}
