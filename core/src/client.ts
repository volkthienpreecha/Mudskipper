/**
 * Typed API client (SPEC B6 "Connectivity notice"). The app never calls `fetch` directly: it calls these
 * functions, and `source` decides where the data comes from.
 *
 * - `source: "api"`: HTTP against the Worker (`baseUrl` defaults to the same origin). Non-2xx responses
 *   throw `ApiError { status, code, message }` from the contract's error body (B6).
 * - `source: "fixtures"`: every call is answered from contracts/fixtures (api/ + run/) in memory, exactly as
 *   the API would answer it: fields are filtered and paged like `GET /api/fields`, any field's detail is
 *   built from run/ data, and `postAudit` runs core's `rank` on the same bytes the API would hash. Pass a
 *   loader: `viteFixtureLoader` (`@mudskipper/core/fixtures-vite`) in the app, `nodeFixtureLoader`
 *   (`@mudskipper/core/fixtures-node`) in Node.
 *
 * This module uses only web-standard APIs, so it runs in browsers, workerd and Node alike.
 */
import type {
  ApiChecks,
  AuditRequest,
  AuditResponse,
  Claims,
  Detectability,
  FieldCollection,
  FieldDetail,
  FieldFeature,
  FieldRow,
  FieldsPage,
  FieldSummaryLine,
  Health,
  Meta,
  ObservationLine,
  Pass,
  Passes,
  Provenance,
  States,
  Story,
  Verdict,
} from "./contracts.gen.ts";
import { parseJsonl } from "./json.ts";
import { checkAuditId, parseFieldsQuery, QueryError } from "./query.ts";
import { rank, RankError, readAuditBody, validateAuditRequest } from "./rank.ts";
import { parseMs } from "./time.ts";

/** API responses always carry `fixture` (C0, T8); the artifact schemas leave it optional. */
export type Served<T> = Omit<T, "fixture"> & { fixture: boolean };

export const PAGE_SIZE = 500;

/** Every file the fixtures source reads, relative to contracts/fixtures/. */
export const FIXTURE_FILES = [
  "api/health.json",
  "api/meta.json",
  "api/story.json",
  "api/passes.json",
  "api/states.json",
  "api/detectability.json",
  "api/checks.json",
  "api/provenance.json",
  "api/audit.response.json",
  "run/fields.geojson",
  "run/observations.jsonl",
  "run/field_summary.jsonl",
  "run/claims.sample.geojson",
] as const;
export type FixtureName = (typeof FIXTURE_FILES)[number];

/**
 * Loads one fixture file. Resolve to the parsed content (a JSON value; for `.jsonl` an array of line
 * values) or to the raw text, which the client parses.
 */
export type FixtureLoader = (name: FixtureName) => Promise<unknown>;

export type ClientOptions =
  | {
      readonly source: "api";
      /** Origin (and optional path prefix) of the API, e.g. `https://mudskipper-nisar.pages.dev`. Default: same origin. */
      readonly baseUrl?: string;
      /** Override `fetch` (tests, SSR). Default: the global `fetch`, looked up at call time. */
      readonly fetch?: typeof fetch;
      /** Abort every request (and its body read) when this signal fires: `ApiError` status 0, code `aborted`. */
      readonly signal?: AbortSignal;
      /** Give up on a request after this many milliseconds: `ApiError` status 0, code `timeout`. */
      readonly timeoutMs?: number;
    }
  | { readonly source: "fixtures"; readonly load: FixtureLoader };

export interface FieldsQuery {
  readonly tile?: string;
  readonly verdict?: Verdict;
  /** 1-based; default 1. */
  readonly page?: number;
}

export interface MudskipperClient {
  readonly source: "api" | "fixtures";
  getHealth(): Promise<Health>;
  getMeta(): Promise<Meta>;
  getStory(): Promise<Served<Story>>;
  getPasses(): Promise<Served<Passes>>;
  getStates(): Promise<Served<States>>;
  getFields(query?: FieldsQuery): Promise<FieldsPage>;
  getField(id: string): Promise<FieldDetail>;
  getDetectability(): Promise<Served<Detectability>>;
  getChecks(): Promise<ApiChecks>;
  getProvenance(): Promise<Served<Provenance>>;
  /** POST /api/audit. A string body is sent (and hashed) byte for byte; an object is sent as JSON.stringify(body). */
  postAudit(body: AuditRequest | string): Promise<AuditResponse>;
  getAudit(id: string): Promise<AuditResponse>;
  /** The run's sample claims (`meta.assets.claims_sample`), for the Scarecrow sample program. */
  getClaimsSample(): Promise<Claims>;
  /** The run's field polygons (`meta.assets.fields_geojson`). */
  getFieldsGeoJson(): Promise<FieldCollection>;
}

/** A failed API call. `status` is the HTTP status (0 when the request never got a response). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function createClient(options: ClientOptions): MudskipperClient {
  return options.source === "api" ? apiClient(options) : fixturesClient(options.load);
}

// ------------------------------------------------------------------------------------------------ api

function apiClient(options: {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): MudskipperClient {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const signals = [options.signal, options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let res: Response;
    let text: string;
    try {
      // The body is read inside the try: a connection that drops mid-body is a network error, not a crash.
      res = await doFetch(base + path, signal ? { ...init, signal } : init);
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError") throw new ApiError(0, "timeout", `request to ${path} took longer than ${options.timeoutMs} ms`);
      if (name === "AbortError") throw new ApiError(0, "aborted", `request to ${path} was aborted`);
      throw new ApiError(0, "network_error", `request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const e = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      if (e && typeof e.code === "string" && typeof e.message === "string") throw new ApiError(res.status, e.code, e.message);
      throw new ApiError(res.status, `http_${res.status}`, `${path}: HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}`);
    }
    if (body === undefined) throw new ApiError(res.status, "invalid_response", `${path}: response is not JSON`);
    return body as T;
  }
  const get = <T>(path: string) => request<T>(path);
  let meta: Promise<Meta> | null = null;
  const asset = async <T>(key: "claims_sample" | "fields_geojson"): Promise<T> => {
    meta ??= get<Meta>("/api/meta").catch((err: unknown) => {
      meta = null;
      throw err;
    });
    const url = (await meta).assets[key];
    if (url === null) throw new ApiError(404, "not_found", `the live run has no ${key} asset`);
    return get<T>(url);
  };

  return {
    source: "api",
    getHealth: () => get("/api/health"),
    getMeta: () => get("/api/meta"),
    getStory: () => get("/api/story"),
    getPasses: () => get("/api/passes"),
    getStates: () => get("/api/states"),
    getFields: (query = {}) => {
      const params = new URLSearchParams();
      if (query.tile !== undefined) params.set("tile", query.tile);
      if (query.verdict !== undefined) params.set("verdict", query.verdict);
      if (query.page !== undefined) params.set("page", String(query.page));
      const qs = params.toString();
      return get(`/api/fields${qs ? "?" + qs : ""}`);
    },
    getField: (id) => get(`/api/fields/${encodeURIComponent(id)}`),
    getDetectability: () => get("/api/detectability"),
    getChecks: () => get("/api/checks"),
    getProvenance: () => get("/api/provenance"),
    postAudit: (body) =>
      request("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    getAudit: (id) => get(`/api/audit/${encodeURIComponent(id)}`),
    getClaimsSample: () => asset("claims_sample"),
    getFieldsGeoJson: () => asset("fields_geojson"),
  };
}

// ------------------------------------------------------------------------------------------------ fixtures

interface RunData {
  runId: string;
  fixture: boolean;
  createdAt: string;
  features: FieldFeature[];
  featureById: Map<string, FieldFeature>;
  summaries: Map<string, FieldSummaryLine>;
  observationsByField: Map<string, ObservationLine[]>;
  passById: Map<string, Pass>;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Run a query check; a QueryError becomes the API's 400 `invalid_request` with the same message. */
function invalidRequest<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    if (err instanceof QueryError) throw new ApiError(400, "invalid_request", err.message);
    throw err;
  }
}

function fixturesClient(load: FixtureLoader): MudskipperClient {
  const cache = new Map<FixtureName, Promise<unknown>>();
  const audits = new Map<string, AuditResponse>();

  function file<T>(name: FixtureName): Promise<T> {
    let p = cache.get(name);
    if (!p) {
      p = Promise.resolve()
        .then(() => load(name))
        .then((value) => {
          if (typeof value !== "string") return value;
          return name.endsWith(".jsonl") ? parseJsonl(value) : JSON.parse(value);
        })
        .catch((err: unknown) => {
          cache.delete(name);
          throw new ApiError(500, "fixture_unavailable", `fixture ${name}: ${err instanceof Error ? err.message : String(err)}`);
        });
      cache.set(name, p);
    }
    return p as Promise<T>;
  }
  // Callers may mutate what they get; the cache must stay pristine.
  const copy = async <T>(name: FixtureName): Promise<T> => structuredClone(await file<T>(name));

  let run: Promise<RunData> | null = null;
  const runData = (): Promise<RunData> => {
    run ??= (async () => {
      const [fields, observations, summaryLines, passes, meta] = await Promise.all([
        file<FieldCollection>("run/fields.geojson"),
        file<ObservationLine[]>("run/observations.jsonl"),
        file<FieldSummaryLine[]>("run/field_summary.jsonl"),
        file<Served<Passes>>("api/passes.json"),
        file<Meta>("api/meta.json"),
      ]);
      const features = [...fields.features].sort((a, b) => byCodeUnits(a.properties.field_id, b.properties.field_id));
      const observationsByField = new Map<string, ObservationLine[]>();
      for (const o of observations) {
        const list = observationsByField.get(o.field_id);
        if (list) list.push(o);
        else observationsByField.set(o.field_id, [o]);
      }
      return {
        runId: fields.run_id,
        fixture: fields.fixture === true,
        createdAt: meta.created_at,
        features,
        featureById: new Map(features.map((f) => [f.properties.field_id, f] as const)),
        summaries: new Map(summaryLines.map((s) => [s.field_id, s] as const)),
        observationsByField,
        passById: new Map(passes.passes.map((p) => [p.pass_id, p] as const)),
      };
    })().catch((err: unknown) => {
      run = null;
      throw err;
    });
    return run;
  };

  async function getFields(query: FieldsQuery = {}): Promise<FieldsPage> {
    // The API's own checks (query.ts): an empty tile or verdict is no filter, pages run 1 to 9,999,999.
    const { tile, verdict, page } = invalidRequest(() => parseFieldsQuery({ tile: query.tile, verdict: query.verdict, page: query.page }));
    const r = await runData();
    const rows: FieldRow[] = [];
    for (const f of r.features) {
      const p = f.properties;
      const s = r.summaries.get(p.field_id);
      if (tile !== null && p.tile !== tile) continue;
      if (verdict !== null && s?.awd.verdict !== verdict) continue;
      rows.push({
        field_id: p.field_id,
        tile: p.tile,
        district: p.district,
        area_ha: p.area_ha,
        source: p.source,
        rice_mask_frac: p.rice_mask_frac,
        lon: p.lon,
        lat: p.lat,
        awd_verdict: s ? s.awd.verdict : null,
        clear_looks: s ? s.awd.clear_looks : null,
        drained_hits: s ? s.awd.drained_hits : null,
        p_catch: s ? s.awd.p_catch_ge1_if_awd : null,
        dsr_signal: s ? s.dsr.signal : null,
      });
    }
    const start = (page - 1) * PAGE_SIZE;
    return {
      v: 1,
      run_id: r.runId,
      fixture: r.fixture,
      page,
      page_size: PAGE_SIZE,
      total: rows.length,
      filters: { tile, verdict },
      fields: rows.slice(start, start + PAGE_SIZE),
      next_page: start + PAGE_SIZE < rows.length ? page + 1 : null,
    };
  }

  async function getField(id: string): Promise<FieldDetail> {
    const r = await runData();
    const f = r.featureById.get(id);
    if (!f) throw new ApiError(404, "not_found", `No field with id ${id} in run ${r.runId}.`);
    const rows = (r.observationsByField.get(id) ?? []).map((o) => {
      const p = r.passById.get(o.pass_id);
      if (!p) throw new ApiError(500, "fixture_unavailable", `observation names unknown pass ${o.pass_id}`);
      return { o, datetime: p.datetime, ms: parseMs(p.datetime) };
    });
    rows.sort((a, b) => a.ms - b.ms); // stable: equal times keep file order, as the reference's sorted()
    const s = r.summaries.get(id);
    return structuredClone({
      v: 1,
      run_id: r.runId,
      fixture: r.fixture,
      field: { properties: f.properties, geometry: f.geometry },
      observations: rows.map(({ o, datetime }) => ({
        pass_id: o.pass_id,
        datetime,
        stage: o.stage,
        n_px: o.n_px,
        valid_frac: o.valid_frac,
        observed: o.observed,
        inferred: o.inferred,
        flags: o.flags,
      })),
      summary: s ? { awd: s.awd, dsr: s.dsr } : null,
    });
  }

  async function postAudit(body: AuditRequest | string): Promise<AuditResponse> {
    const r = await runData();
    try {
      const { request, inputHash } = await readAuditBody(typeof body === "string" ? body : JSON.stringify(body));
      const valid = validateAuditRequest(request);
      const out = await rank(valid, inputHash, r.features, r.summaries, r.runId, r.createdAt, r.fixture);
      audits.set(out.audit_id, out);
      return structuredClone(out);
    } catch (err) {
      if (err instanceof RankError) throw new ApiError(err.status, err.code, err.message);
      throw err;
    }
  }

  async function getAudit(id: string): Promise<AuditResponse> {
    invalidRequest(() => checkAuditId(id));
    const stored = audits.get(id);
    if (stored) return structuredClone(stored);
    const golden = await copy<AuditResponse>("api/audit.response.json");
    if (golden.audit_id === id) return golden;
    throw new ApiError(404, "not_found", `No audit with id ${id}.`);
  }

  return {
    source: "fixtures",
    getHealth: () => copy("api/health.json"),
    getMeta: () => copy("api/meta.json"),
    getStory: () => copy("api/story.json"),
    getPasses: () => copy("api/passes.json"),
    getStates: () => copy("api/states.json"),
    getFields,
    getField,
    getDetectability: () => copy("api/detectability.json"),
    getChecks: () => copy("api/checks.json"),
    getProvenance: () => copy("api/provenance.json"),
    postAudit,
    getAudit,
    getClaimsSample: () => copy("run/claims.sample.geojson"),
    getFieldsGeoJson: () => copy("run/fields.geojson"),
  };
}
