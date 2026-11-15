/**
 * Row encodings for the D1 tables in migrations/0001_init.sql, both directions. The loader (src/d1/plan.ts)
 * encodes run objects into rows; the D1 repository (src/repo/d1.ts) decodes rows back into the exact objects,
 * so every D1 response equals the static bundle's by parsed value.
 */
import type { FieldFeature, FieldSummary, JsonObject, Observation, Pass } from "../contracts.ts";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface TableDef {
  name: string;
  /** Primary key columns, in order (always starting with run_id). */
  pk: string[];
  /** Every column, PK first. */
  columns: string[];
}

export const FIELDS: TableDef = {
  name: "fields",
  pk: ["run_id", "field_id"],
  columns: ["run_id", "field_id", "tile", "district", "area_ha", "source", "rice_mask_frac", "lon", "lat", "geometry"],
};

export const PASSES: TableDef = {
  name: "passes",
  pk: ["run_id", "pass_id"],
  columns: [
    "run_id", "pass_id", "granule_id", "datetime", "direction", "track", "frame", "pol_mode", "covariance_terms",
    "crid", "maturity", "pixel_m", "valid_fraction_by_tile", "used", "excluded_reason",
  ],
};

export const OBSERVATIONS: TableDef = {
  name: "observations",
  pk: ["run_id", "field_id", "pass_id"],
  columns: [
    "run_id", "field_id", "pass_id", "state", "p_flooded", "confidence", "stage", "hh_db", "hv_db", "ps_db", "pd_db",
    "pv_db", "valid_frac", "vv_db", "hh_hv_db", "observed_keys", "n_px", "method", "flags",
  ],
};

export const SUMMARIES: TableDef = {
  name: "summaries",
  pk: ["run_id", "field_id"],
  columns: [
    "run_id", "field_id", "awd_verdict", "drained_hits", "clear_looks", "p_catch", "awd_reason", "dsr_signal",
    "dsr_reason", "k_star", "window_start", "window_end", "window_source",
  ],
};

export const DOCS: TableDef = { name: "docs", pk: ["run_id", "name"], columns: ["run_id", "name", "body"] };

/** Tables a run load writes, in load order. */
export const RUN_TABLES = [FIELDS, PASSES, OBSERVATIONS, SUMMARIES, DOCS] as const;

const num = (x: unknown): number | null => (typeof x === "number" ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

// ------------------------------------------------------------------------------------------------ fields
export function fieldToRow(runId: string, f: FieldFeature): Row {
  const p = f.properties;
  return {
    run_id: runId, field_id: p.field_id, tile: p.tile, district: p.district, area_ha: p.area_ha, source: p.source,
    rice_mask_frac: p.rice_mask_frac, lon: p.lon, lat: p.lat, geometry: JSON.stringify(f.geometry),
  };
}

export function rowToField(r: Row): FieldFeature {
  return {
    type: "Feature",
    geometry: JSON.parse(r["geometry"] as string) as JsonObject,
    properties: {
      field_id: r["field_id"] as string,
      tile: r["tile"] as string,
      district: r["district"] as string,
      area_ha: r["area_ha"] as number,
      source: r["source"] as string,
      rice_mask_frac: r["rice_mask_frac"] as number,
      lon: r["lon"] as number,
      lat: r["lat"] as number,
    },
  };
}

// ------------------------------------------------------------------------------------------------ passes
export function passToRow(runId: string, p: Pass): Row {
  return {
    run_id: runId, pass_id: p.pass_id, granule_id: p.granule_id, datetime: p.datetime, direction: p.direction,
    track: p.track, frame: p.frame, pol_mode: p.pol_mode, covariance_terms: JSON.stringify(p["covariance_terms"] ?? []),
    crid: p.crid, maturity: p.maturity, pixel_m: num(p["pixel_m"]),
    valid_fraction_by_tile: JSON.stringify(p["valid_fraction_by_tile"] ?? {}), used: p.used ? 1 : 0,
    excluded_reason: str(p["excluded_reason"]),
  };
}

// ------------------------------------------------------------------------------------------------ observations
/** Optional quad-pol members of `observed`, in schema order. */
const QP_KEYS = ["vv_db", "ps_db", "pd_db", "pv_db"] as const;

export function observationToRow(runId: string, o: Observation): Row {
  const ob = o.observed;
  return {
    run_id: runId, field_id: o.field_id, pass_id: o.pass_id, state: o.inferred.state, p_flooded: o.inferred.p_flooded,
    confidence: o.inferred.confidence, stage: o.stage, hh_db: num(ob["hh_db"]), hv_db: num(ob["hv_db"]),
    ps_db: num(ob["ps_db"]), pd_db: num(ob["pd_db"]), pv_db: num(ob["pv_db"]), valid_frac: o.valid_frac,
    vv_db: num(ob["vv_db"]), hh_hv_db: num(ob["hh_hv_db"]),
    observed_keys: QP_KEYS.filter((k) => k in ob).join(","),
    n_px: o.n_px, method: o.inferred.method, flags: JSON.stringify(o.flags),
  };
}

export function rowToObservation(r: Row): Observation {
  const present = new Set(String(r["observed_keys"] ?? "").split(",").filter(Boolean));
  const observed: JsonObject = { hh_db: r["hh_db"] ?? null, hv_db: r["hv_db"] ?? null };
  for (const k of QP_KEYS) if (present.has(k)) observed[k] = r[k] ?? null;
  observed["hh_hv_db"] = r["hh_hv_db"] ?? null;
  return {
    field_id: r["field_id"] as string,
    pass_id: r["pass_id"] as string,
    n_px: r["n_px"] as number,
    valid_frac: r["valid_frac"] as number,
    observed,
    stage: r["stage"] as Observation["stage"],
    inferred: {
      state: r["state"] as string,
      p_flooded: (r["p_flooded"] as number | null) ?? null,
      confidence: (r["confidence"] as number | null) ?? null,
      method: r["method"] as string,
    },
    flags: JSON.parse(r["flags"] as string) as string[],
  };
}

// ------------------------------------------------------------------------------------------------ summaries
export function summaryToRow(runId: string, s: FieldSummary): Row {
  return {
    run_id: runId, field_id: s.field_id, awd_verdict: s.awd.verdict, drained_hits: s.awd.drained_hits,
    clear_looks: s.awd.clear_looks, p_catch: s.awd.p_catch_ge1_if_awd, awd_reason: s.awd.reason,
    dsr_signal: s.dsr.signal, dsr_reason: s.dsr.reason, k_star: s.awd.k_star, window_start: s.awd.window.start,
    window_end: s.awd.window.end, window_source: s.awd.window.source,
  };
}

export function rowToSummary(r: Row, runId: string, fixture: boolean): FieldSummary {
  return {
    v: 1,
    run_id: runId,
    fixture,
    field_id: r["field_id"] as string,
    awd: {
      window: { start: r["window_start"] as string, end: r["window_end"] as string, source: r["window_source"] as string },
      clear_looks: r["clear_looks"] as number,
      drained_hits: r["drained_hits"] as number,
      p_catch_ge1_if_awd: r["p_catch"] as number,
      k_star: (r["k_star"] as number | null) ?? null,
      verdict: r["awd_verdict"] as FieldSummary["awd"]["verdict"],
      reason: r["awd_reason"] as string,
    },
    dsr: { signal: r["dsr_signal"] as FieldSummary["dsr"]["signal"], reason: r["dsr_reason"] as string },
  };
}
