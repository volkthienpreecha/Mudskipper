/**
 * The slice of the contract (contracts/schemas) the platform touches, typed by hand.
 *
 * TODO(core): replace these with the generated types from `@mudskipper/core/contracts` once core is on main.
 * They are deliberately loose where the platform only passes data through (e.g. `Doc`), and exact where the
 * platform builds a response itself (field rows, field detail, the audit envelope). The JSON Schemas stay the
 * source of truth: every response is schema-validated in the tests and by scripts/smoke.ts.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Any run document (passes.json, story.json, …): an object with the C0 header. */
export interface Doc extends JsonObject {
  v: 1;
  run_id: string;
}

export interface Live {
  v: 1;
  run_id: string;
  fixture: boolean;
  updated_at?: string;
}

export type Verdict = "consistent" | "inconsistent" | "not_enough_evidence";
export type DsrSignal = "dsr_signal" | "transplant_signal" | "unknown";
export type Stage = "early" | "mid" | "late";

export interface FieldProperties extends JsonObject {
  field_id: string;
  tile: string;
  district: string;
  area_ha: number;
  source: string;
  rice_mask_frac: number;
  lon: number;
  lat: number;
}

export interface FieldFeature {
  type: "Feature";
  id?: string | number;
  geometry: JsonObject;
  properties: FieldProperties;
}

export interface Pass extends JsonObject {
  pass_id: string;
  granule_id: string;
  datetime: string;
  direction: string;
  track: number;
  frame: number;
  pol_mode: string;
  crid: string;
  maturity: string;
  used: boolean;
}

export interface Observation extends JsonObject {
  field_id: string;
  pass_id: string;
  n_px: number;
  valid_frac: number;
  observed: JsonObject;
  stage: Stage;
  inferred: { state: string; p_flooded: number | null; confidence: number | null; method: string };
  flags: string[];
}

export interface AwdSummary extends JsonObject {
  window: { start: string; end: string; source: string };
  clear_looks: number;
  drained_hits: number;
  p_catch_ge1_if_awd: number;
  k_star: number | null;
  verdict: Verdict;
  reason: string;
}

export interface FieldSummary extends JsonObject {
  field_id: string;
  awd: AwdSummary;
  dsr: { signal: DsrSignal; reason: string };
}

/** One row of GET /api/fields (schema api/fields_page → field_row). */
export interface FieldRow extends JsonObject {
  field_id: string;
  tile: string;
  district: string;
  area_ha: number;
  source: string;
  rice_mask_frac: number;
  lon: number;
  lat: number;
  awd_verdict: Verdict | null;
  clear_looks: number | null;
  drained_hits: number | null;
  p_catch: number | null;
  dsr_signal: DsrSignal | null;
}

export interface ObservationRow extends JsonObject {
  pass_id: string;
  datetime: string;
  stage: Stage;
  n_px: number;
  valid_frac: number;
  observed: JsonObject;
  inferred: JsonObject;
  flags: string[];
}

/** GET /api/fields/:id (schema api/field_detail). */
export interface FieldDetail extends JsonObject {
  v: 1;
  run_id: string;
  fixture: boolean;
  field: { properties: FieldProperties; geometry: JsonObject | null };
  observations: ObservationRow[];
  summary: { awd: AwdSummary; dsr: FieldSummary["dsr"] } | null;
}

/** POST /api/audit request body (schema api/audit_request), after validation. */
export interface AuditRequest {
  claims: { type: "FeatureCollection"; features: ClaimFeature[]; [key: string]: unknown };
  budget: number;
  seed?: number;
}

export interface ClaimFeature {
  type: "Feature";
  geometry: { type: "Point" | "Polygon" | "MultiPolygon"; coordinates: unknown };
  properties: { claimed: string[]; synthetic: boolean; claim_id?: string; field_id?: string; area_ha?: number };
}

/** POST /api/audit and GET /api/audit/:id (schema api/audit_response). */
export interface AuditResponse extends JsonObject {
  v: 1;
  run_id: string;
  fixture: boolean;
  audit_id: string;
  created_at: string;
  budget: number;
  seed: number;
  input_hash: string;
  synthetic: boolean;
  matched: number;
  unmatched: number;
  ranked: JsonObject[];
  notice: string;
}

/** The run-level API documents, by route name. */
export const DOC_NAMES = ["meta", "story", "passes", "detectability", "states", "checks", "provenance"] as const;
export type DocName = (typeof DOC_NAMES)[number];

export const VERDICTS: readonly Verdict[] = ["consistent", "inconsistent", "not_enough_evidence"];
export const TILE_ID = /^[a-z][a-z0-9]{0,15}$/;
export const FIELD_ID = /^[a-z][a-z0-9]{0,15}-[0-9]{5}$/;
export const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AUDIT_ID = /^a_[0-9a-f]{16}$/;
