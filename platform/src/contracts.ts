/**
 * Contract types for the platform: the generated types from `@mudskipper/core/contracts` (built from
 * contracts/schemas by core/scripts/gen-types.mjs), plus a few loose helpers for documents the platform only
 * passes through. The JSON Schemas stay the source of truth: every response is schema-validated in the tests
 * and by scripts/smoke.ts.
 */
import type * as C from "@mudskipper/core/contracts";

export type {
  AuditRequest,
  AuditResponse,
  AwdSummary,
  DsrSignal,
  FieldDetail,
  FieldProperties,
  FieldRow,
  FieldsPage,
  Live,
  ObservationRow,
  Pass,
  Stage,
  Verdict,
} from "@mudskipper/core/contracts";

/** One feature of fields.geojson. */
export type FieldFeature = C.FieldFeature;
/** One line of field_summary.jsonl. */
export type FieldSummary = C.FieldSummaryLine;
/** One line of observations.jsonl. */
export type Observation = C.ObservationLine;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Any run document as the platform passes it through (passes.json, story.json, …): an object with the C0 header. */
export interface Doc {
  v: 1;
  run_id: string;
  fixture?: boolean;
  [key: string]: unknown;
}

/** The run-level API documents, by route name. */
export const DOC_NAMES = ["meta", "story", "passes", "detectability", "states", "checks", "provenance"] as const;
export type DocName = (typeof DOC_NAMES)[number];

export const FIELD_ID = /^[a-z][a-z0-9]{0,15}-[0-9]{5}$/;
export const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AUDIT_ID = /^a_[0-9a-f]{16}$/;
