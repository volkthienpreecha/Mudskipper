/**
 * Pure builders for every run-scoped API response (CONTRACTS.md B6), shared by the static bundle builder
 * (scripts/build-bundle.ts), the D1 loader (src/d1/plan.ts) and the D1 repository. Keeping one builder is what
 * makes the two storage backends return the same bytes-for-meaning (tests compare them by parsed value).
 *
 * No I/O here: callers hand in a parsed run (`RunData`).
 */
import type {
  Doc,
  FieldDetail,
  FieldFeature,
  FieldRow,
  FieldSummary,
  JsonObject,
  Observation,
  ObservationRow,
  Pass,
} from "./contracts.ts";
import { LIMITS_TEXT, PAGE_SIZE } from "./limits.ts";

/** A parsed run directory (artifacts/<run_id>/ or contracts/fixtures/run/). */
export interface RunData {
  run_id: string;
  fixture: boolean;
  aoi: Doc;
  fields: { features: FieldFeature[] } & JsonObject;
  passes: Doc & { passes: Pass[] };
  observations: Observation[];
  /** null until core has run (pipeline stage). */
  summaries: FieldSummary[] | null;
  detectability: Doc | null;
  story: Doc | null;
  states: Doc | null;
  checks: Doc | null;
  district: Doc | null;
  provenance: Doc;
  overlays: Doc | null;
  /** Relative POSIX paths of every file in the run directory. */
  files: string[];
}

/** C0 header in schema key order. */
export function header(runId: string, fixture: boolean): { v: 1; run_id: string; fixture: boolean } {
  return { v: 1, run_id: runId, fixture };
}

/** A run document as an API response: header first (schema key order), `fixture` always a boolean (T8). */
export function asResponse(doc: Record<string, unknown>, runId: string, fixture: boolean): Doc {
  const { v: _v, run_id: _r, fixture: _f, ...rest } = doc;
  return { ...header(runId, fixture), ...rest } as Doc;
}

const STAGES = ["early", "mid", "late"] as const;

export function tilesBase(runId: string): string {
  return `/tiles/runs/${runId}/`;
}

/** GET /api/meta (schema api/meta). Asset URLs point at /tiles/runs/<run_id>/… and are null when absent. */
export function buildMeta(run: RunData): Doc {
  const base = tilesBase(run.run_id);
  const has = (p: string) => run.files.includes(p);
  const asset = (p: string) => (has(p) ? base + p : null);
  const used = run.passes.passes.filter((p) => p.used);
  const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();
  const aoi = run.aoi as JsonObject;
  const prov = run.provenance as JsonObject;
  return {
    ...header(run.run_id, run.fixture),
    created_at: prov["created_at"] as string,
    git_sha: prov["git_sha"] as string,
    season: aoi["season"]!,
    stages: aoi["stages"]!,
    gaps: aoi["gaps"]!,
    tiles: aoi["tiles"]!,
    counts: {
      fields: run.fields.features.length,
      passes: run.passes.passes.length,
      passes_used: used.length,
      observations: run.observations.length,
    },
    pol_modes: sortedUnique(used.map((p) => p.pol_mode)),
    methods: sortedUnique(run.observations.map((o) => o.inferred.method)),
    crids: sortedUnique(used.map((p) => p.crid)),
    assets: {
      fields_geojson: asset("fields.geojson"),
      fields_pmtiles: asset("fields.pmtiles"),
      overlays_index: asset("overlays/index.json"),
      claims_sample: asset("claims.sample.geojson"),
      hist: Object.fromEntries(STAGES.map((s) => [s, asset(`hist/${s}.png`)])),
    },
    limits_text: LIMITS_TEXT,
  } as Doc;
}

/** One GET /api/fields row: field properties plus the summary columns (null until published). */
export function fieldRow(props: FieldFeature["properties"], s: FieldSummary | undefined): FieldRow {
  return {
    field_id: props.field_id,
    tile: props.tile,
    district: props.district,
    area_ha: props.area_ha,
    source: props.source,
    rice_mask_frac: props.rice_mask_frac,
    lon: props.lon,
    lat: props.lat,
    awd_verdict: s ? s.awd.verdict : null,
    clear_looks: s ? s.awd.clear_looks : null,
    drained_hits: s ? s.awd.drained_hits : null,
    p_catch: s ? s.awd.p_catch_ge1_if_awd : null,
    dsr_signal: s ? s.dsr.signal : null,
  };
}

export function observationRow(o: Observation, datetime: string): ObservationRow {
  return {
    pass_id: o.pass_id,
    datetime,
    stage: o.stage,
    n_px: o.n_px,
    valid_frac: o.valid_frac,
    observed: o.observed,
    inferred: o.inferred,
    flags: o.flags,
  };
}

/** Observations of one field ordered by pass datetime (stable, so file order breaks ties), as rows. */
export function orderedObservationRows(obs: Observation[], datetimeOf: (passId: string) => string): ObservationRow[] {
  return obs
    .map((o, i) => ({ o, i, t: Date.parse(datetimeOf(o.pass_id)) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ o }) => observationRow(o, datetimeOf(o.pass_id)));
}

/** GET /api/fields/:id (schema api/field_detail). */
export function fieldDetail(
  runId: string,
  fixture: boolean,
  feature: FieldFeature,
  rows: ObservationRow[],
  s: FieldSummary | undefined,
): FieldDetail {
  return {
    ...header(runId, fixture),
    field: { properties: feature.properties, geometry: feature.geometry ?? null },
    observations: rows,
    summary: s ? { awd: s.awd, dsr: s.dsr } : null,
  };
}

/** Every run-scoped response, built from a parsed run. */
export interface ApiDocs {
  meta: Doc;
  story: Doc | null;
  passes: Doc;
  detectability: Doc | null;
  states: Doc | null;
  checks: Doc | null;
  provenance: Doc;
  /** All field rows ordered by field_id; the API filters and pages them. */
  fieldRows: FieldRow[];
  /** One detail per field_id. */
  details: Map<string, FieldDetail>;
}

export function buildApiDocs(run: RunData): ApiDocs {
  const { run_id: id, fixture } = run;
  const summaries = new Map((run.summaries ?? []).map((s) => [s.field_id, s]));
  const datetimes = new Map(run.passes.passes.map((p) => [p.pass_id, p.datetime]));
  const datetimeOf = (pid: string) => {
    const dt = datetimes.get(pid);
    if (dt === undefined) throw new Error(`observation references unknown pass ${pid}`);
    return dt;
  };
  const features = [...run.fields.features].sort((a, b) => cmp(a.properties.field_id, b.properties.field_id));
  const obsByField = new Map<string, Observation[]>();
  for (const o of run.observations) {
    const list = obsByField.get(o.field_id);
    if (list) list.push(o);
    else obsByField.set(o.field_id, [o]);
  }
  const details = new Map<string, FieldDetail>();
  for (const f of features) {
    const fid = f.properties.field_id;
    details.set(fid, fieldDetail(id, fixture, f, orderedObservationRows(obsByField.get(fid) ?? [], datetimeOf), summaries.get(fid)));
  }
  const checks = run.checks
    ? ({
        ...header(id, fixture),
        season_shape: (run.checks as JsonObject)["season_shape"]!,
        opera: (run.checks as JsonObject)["opera"] ?? null,
        district: run.district ? asResponse(run.district, id, fixture) : null,
      } as Doc)
    : null;
  const opt = (d: Doc | null) => (d ? asResponse(d, id, fixture) : null);
  return {
    meta: buildMeta(run),
    story: opt(run.story),
    passes: asResponse(run.passes, id, fixture),
    detectability: opt(run.detectability),
    states: opt(run.states),
    checks,
    provenance: asResponse(run.provenance, id, fixture),
    fieldRows: features.map((f) => fieldRow(f.properties, summaries.get(f.properties.field_id))),
    details,
  };
}

/** UTF-16 code-unit comparison (C0 string order), never localeCompare. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FieldQuery {
  tile: string | null;
  verdict: string | null;
  page: number;
}

/** GET /api/fields (schema api/fields_page): filter by tile and verdict, 1-based pages of PAGE_SIZE. */
export function fieldsPage(runId: string, fixture: boolean, rows: FieldRow[], q: FieldQuery): Doc {
  const matching = rows.filter((r) => (q.tile === null || r.tile === q.tile) && (q.verdict === null || r.awd_verdict === q.verdict));
  const start = (q.page - 1) * PAGE_SIZE;
  const fields = matching.slice(start, start + PAGE_SIZE);
  return {
    ...header(runId, fixture),
    page: q.page,
    page_size: PAGE_SIZE,
    total: matching.length,
    filters: { tile: q.tile, verdict: q.verdict },
    fields,
    next_page: start + PAGE_SIZE < matching.length ? q.page + 1 : null,
  } as Doc;
}
