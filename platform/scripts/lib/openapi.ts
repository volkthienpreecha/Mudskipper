/**
 * OpenAPI 3.1 description of the Mudskipper API, generated at build time from contracts/schemas (DECISIONS.md
 * K-324). The response and request bodies are the contract's own JSON Schemas (draft 2020-12, which OpenAPI 3.1
 * uses natively): every schema file becomes a component, every `$defs` entry its own component, and every
 * `$ref` is rewritten to `#/components/schemas/…`, so the spec cannot drift from the schemas the API is tested
 * against. Operations are listed here once; test/node/openapi.test.ts checks them against the Hono app's routes.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { MAX_BODY_BYTES, MAX_CLAIMS, PAGE_SIZE, AUDIT_NOTICE, LIMITS_TEXT } from "../../src/limits.ts";
import { defaultRateLimiter, defaultStoreBudget } from "../../src/audit/guard.ts";
import { AUDIT_TTL_SECONDS } from "../../src/audit/store.ts";
import { SCHEMA_DIR } from "./schemas.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const API_NAMES: Record<string, string> = {
  "api/audit_request.schema.json": "AuditRequest",
  "api/audit_response.schema.json": "AuditResponse",
  "api/error.schema.json": "Error",
};

const pascal = (s: string) => s.replace(/(^|_)([a-z0-9])/g, (_m, _u, c: string) => c.toUpperCase());

/** Component name of a schema file (relative to contracts/schemas). */
export function componentName(rel: string): string {
  if (API_NAMES[rel]) return API_NAMES[rel];
  const base = posix.basename(rel, ".schema.json");
  return rel.startsWith("api/") ? `${pascal(base)}Response` : pascal(base);
}

/**
 * Every schema reachable from `roots`, as OpenAPI components: `$schema`/`$id` dropped, `$defs` hoisted to
 * `<Owner>_<name>`, refs rewritten. Throws on a ref it cannot place (so a new kind of ref fails the build).
 */
export function schemaComponents(roots: string[]): Record<string, Obj> {
  const out: Record<string, Obj> = {};
  const queue = [...roots];
  const seen = new Set<string>();
  const load = (rel: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, rel), "utf8")) as Obj;

  const rewrite = (node: Json, rel: string): Json => {
    if (Array.isArray(node)) return node.map((n) => rewrite(n, rel));
    if (node === null || typeof node !== "object") return node;
    const res: Obj = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        const [file, frag = ""] = v.split("#");
        const target = file ? posix.normalize(posix.join(posix.dirname(rel), file)) : rel;
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
        const m = /^\/\$defs\/([A-Za-z0-9_]+)$/.exec(frag);
        if (frag && !m) throw new Error(`${rel}: cannot place $ref ${v} in OpenAPI components`);
        res[k] = `#/components/schemas/${componentName(target)}${m ? "_" + m[1] : ""}`;
      } else if (k === "$schema" || k === "$id") continue;
      else res[k] = rewrite(v, rel);
    }
    return res;
  };

  for (const r of roots) seen.add(r);
  while (queue.length) {
    const rel = queue.shift()!;
    const schema = load(rel);
    const name = componentName(rel);
    const defs = (schema["$defs"] ?? {}) as Obj;
    delete schema["$defs"];
    out[name] = rewrite(schema, rel) as Obj;
    for (const [d, s] of Object.entries(defs)) {
      if (s && typeof s === "object" && "$defs" in (s as Obj)) throw new Error(`${rel}: nested $defs in ${d} are not supported`);
      out[`${name}_${d}`] = rewrite(s, rel) as Obj;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const ref = (name: string): Obj => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (name: string, description: string, headers?: Obj): Obj => ({
  description,
  ...(headers ? { headers } : {}),
  content: { "application/json": { schema: ref(name) } },
});
/**
 * Error responses, written inline in every operation (not as $refs to components/responses) so every operation
 * names the Error schema itself: some tools only follow schema refs.
 */
const ERROR_RESPONSES: Record<string, Obj> = {
  NotModified: { description: "Not modified: the ETag still matches." },
  BadRequest: jsonBody("Error", "Invalid request: invalid_json, invalid_request, too_many_claims, duplicate_claim_id or invalid_geometry (audits), or a bad query parameter."),
  NotFound: jsonBody("Error", "not_found: no such field, audit, file or route."),
  TooLarge: jsonBody("Error", `too_large: the body is over ${MAX_BODY_BYTES} bytes.`),
  RateLimited: jsonBody("Error", "rate_limited: too many audits from this address.", { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }),
  PreconditionFailed: jsonBody("Error", "precondition_failed: an If-Match precondition did not hold."),
  RangeNotSatisfiable: jsonBody("Error", "range_not_satisfiable: the range lies outside the file.", { "Content-Range": { $ref: "#/components/headers/ContentRange" } }),
  Unavailable: jsonBody("Error", "no_live_run (the live run's data is missing) or storage_unavailable (audit storage is not configured)."),
  Internal: jsonBody("Error", "internal: an unexpected error; nothing was stored."),
  MethodNotAllowed: jsonBody("Error", "method_not_allowed: the path exists but not for this method; Allow lists the methods.", { Allow: { schema: { type: "string" } } }),
};
const err = (name: string): Obj => ERROR_RESPONSES[name]!;

/** One GET of a live-scoped run document (ETag + 304, CACHE.live). */
function docGet(operationId: string, summary: string, description: string, schema: string, extra: Obj = {}): Obj {
  return {
    get: {
      operationId,
      summary,
      description,
      tags: ["Run data"],
      security: [],
      parameters: [{ $ref: "#/components/parameters/IfNoneMatch" }],
      responses: {
        "200": jsonBody(schema, "The document for the live run.", {
          ETag: { $ref: "#/components/headers/ETag" },
          "Cache-Control": { $ref: "#/components/headers/CacheControl" },
        }),
        "304": err("NotModified"),
        "404": err("NotFound"),
        "503": err("Unavailable"),
        "500": err("Internal"),
      },
      ...extra,
    },
  };
}

export interface OpenApiOptions {
  siteUrl: string;
  /** Real run ids are r01, r02, …; the sample run is "fixture". Used for examples only. */
  exampleRunId: string;
  exampleFieldId: string | null;
  /** The site has a /terms page. */
  terms?: boolean;
}

export function buildOpenApi(opts: OpenApiOptions): Obj {
  const limiter = defaultRateLimiter();
  const budget = defaultStoreBudget();
  const every = Math.round(1 / limiter.perSecond);
  const rate =
    `Rate limit: ${limiter.capacity} audits at once per client IP, then one every ${every} s (a token bucket per ` +
    `Cloudflare isolate, so per data centre); over it the API answers 429 rate_limited with Retry-After. ` +
    `At most ${budget.perDay} new audits are stored per day (Workers KV free-plan write limit); past that an audit ` +
    `is still ranked but not stored (200, x-audit-stored: false, no Location). Stored audits expire after ` +
    `${AUDIT_TTL_SECONDS / 86_400} days.`;

  const roots = [
    "api/health.schema.json",
    "api/meta.schema.json",
    "api/story.schema.json",
    "api/passes.schema.json",
    "api/states.schema.json",
    "api/fields_page.schema.json",
    "api/field_detail.schema.json",
    "api/detectability.schema.json",
    "api/checks.schema.json",
    "api/provenance.schema.json",
    "api/audit_request.schema.json",
    "api/audit_response.schema.json",
    "api/error.schema.json",
  ];
  const schemas: Record<string, Obj> = {
    ...schemaComponents(roots),
    ApiIndex: {
      title: "GET /api",
      description: "The endpoint index: the C0 header, this deployment's limits and every route.",
      type: "object",
      properties: {
        v: ref("Common_v"),
        run_id: ref("Common_run_id"),
        fixture: { type: "boolean", description: "true while the live run is the SAMPLE fixture run, not real NISAR results." },
        name: { type: "string" },
        description: { type: "string" },
        contract: { type: "string", format: "uri" },
        limits: {
          type: "object",
          properties: {
            audit_max_claims: { type: "integer", const: MAX_CLAIMS },
            audit_max_body_bytes: { type: "integer", const: MAX_BODY_BYTES },
            fields_page_size: { type: "integer", const: PAGE_SIZE },
          },
          required: ["audit_max_claims", "audit_max_body_bytes", "fields_page_size"],
        },
        endpoints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              methods: { type: "array", items: { type: "string", enum: ["GET", "POST"] } },
              description: { type: "string" },
            },
            required: ["path", "methods", "description"],
          },
        },
      },
      required: ["v", "run_id", "fixture", "name", "description", "contract", "limits", "endpoints"],
    },
  };

  const tileOp = (operationId: string, summary: string, fileParam: string, pattern: string): Obj => ({
    get: {
      operationId,
      summary,
      description:
        "Serves one file of a published run with HTTP Range support (CONTRACTS.md B5), for PMTiles and large GeoJSON. " +
        "A single `Range: bytes=…` answers 206 with Content-Range; an unsatisfiable range 416; `If-None-Match` with the " +
        "file's strong ETag (its sha256) 304; `If-Range` falls back to the whole file when it does not match. HEAD is " +
        "also accepted. A real run's files never change (cached for a year); the SAMPLE fixture run's for 5 minutes. " +
        "The live run's own paths are listed in `GET /api/meta` → `assets`.",
      tags: ["Run files"],
      security: [],
      parameters: [
        { $ref: "#/components/parameters/RunId" },
        {
          name: fileParam,
          in: "path",
          required: true,
          description: "File name inside the run directory.",
          schema: { type: "string", pattern },
        },
        { $ref: "#/components/parameters/Range" },
        { $ref: "#/components/parameters/IfRange" },
        { $ref: "#/components/parameters/IfNoneMatch" },
      ],
      responses: {
        "200": { $ref: "#/components/responses/FileBytes" },
        "206": { $ref: "#/components/responses/PartialBytes" },
        "304": err("NotModified"),
        "404": err("NotFound"),
        "412": err("PreconditionFailed"),
        "416": err("RangeNotSatisfiable"),
        "503": err("Unavailable"),
        "500": err("Internal"),
      },
    },
  });

  const exampleField = opts.exampleFieldId ?? "fazilka-00001";
  return pruneSchemas({
    openapi: "3.1.0",
    info: {
      title: "Mudskipper API",
      version: "1.0.0",
      summary: "NISAR radar evidence of rice-field drainage in Punjab, India, field by field.",
      description:
        "Public, read-only data from Mudskipper, a NASA Space Apps Challenge 2026 project: NASA-ISRO NISAR L-band radar " +
        "turned into a per-pass state (flooded, drained or uncertain) for every mapped rice field in two 15 km study " +
        "tiles in Fazilka and Sri Muktsar Sahib, Punjab, a season verdict on alternate wetting and drying (AWD), a " +
        "direct-seeded rice (DSR) signal, what the pass dates can and cannot detect, and an anonymous endpoint that " +
        "ranks claimed fields for inspection.\n\n" +
        "No authentication, no API key, no cookies; CORS is open (`Access-Control-Allow-Origin: *`). Every success " +
        "is JSON with `v` (contract version), `run_id` (the live run) and `fixture` (true while the live run is the " +
        "SAMPLE fixture run, so its numbers are not results). Every failure is `{\"error\":{\"code\",\"message\"}}`.\n\n" +
        "Every number has an evidence tag: OBSERVED (a radar measurement), INFERRED (our model's reading) or ASSUMED " +
        "(a cited parameter); the tag of each field is fixed in contracts/evidence_tags.json.\n\n" +
        "Versioning: every response carries the contract version `v` (1, this document's 1.x); within a version changes are additive only (new endpoints or fields, never removed or renamed ones), so ignore unknown fields.\n\n" +
        `Limits: ${LIMITS_TEXT}`,
      ...(opts.terms ? { termsOfService: `${opts.siteUrl}/terms` } : {}),
      contact: { name: "Mudskipper team (NASA Space Apps 2026)", url: `${opts.siteUrl}/contact` },
      license: { name: "GPL-3.0-only (code); data keep their sources' licences", identifier: "GPL-3.0-only" },
    },
    externalDocs: { description: "Developer guide: quickstart, limits, evidence tags", url: `${opts.siteUrl}/developers` },
    servers: [{ url: opts.siteUrl, description: "Production (Cloudflare Pages)" }],
    security: [],
    tags: [
      { name: "Discovery", description: "What this API is and whether it is up." },
      { name: "Run data", description: "Documents of the live run. Cached 60 s, revalidate with the ETag." },
      { name: "Fields", description: "Mapped rice fields with their season summary." },
      { name: "Audits", description: "Rank claimed fields for inspection (anonymous, rate-limited)." },
      { name: "Run files", description: "Raw run files (GeoJSON, PMTiles, overlays) with Range support." },
    ],
    paths: {
      "/api": {
        get: {
          operationId: "getApiIndex",
          summary: "List the API's endpoints and limits",
          description: "Returns the endpoint index with this deployment's audit and paging limits. Start here.",
          tags: ["Discovery"],
          security: [],
          responses: { "200": jsonBody("ApiIndex", "The endpoint index."), "405": err("MethodNotAllowed"), "503": err("Unavailable"), "500": err("Internal") },
        },
      },
      "/api/health": {
        get: {
          operationId: "getHealth",
          summary: "Check that the API and the live run are up",
          description: "ok is true only when the live run's data is actually present. Never cached.",
          tags: ["Discovery"],
          security: [],
          responses: { "200": jsonBody("HealthResponse", "The API is up and serving the named run."), "405": err("MethodNotAllowed"), "503": err("Unavailable"), "500": err("Internal") },
        },
      },
      "/api/meta": docGet(
        "getRunMeta",
        "Get the live run's season, tiles, counts and asset URLs",
        "Season and stage dates, the NISAR data gap, the study tiles (id, district, bbox), counts of fields, passes and observations, polarization modes, methods, CRIDs, the URLs of the run's files and the Limits text.",
        "MetaResponse",
      ),
      "/api/story": docGet(
        "getStory",
        "Get the headline and hero field",
        "The run's one-sentence headline (with its evidence tag), the hero tile and field, and the counts behind them.",
        "StoryResponse",
      ),
      "/api/passes": docGet(
        "listPasses",
        "List every NISAR pass, used or excluded",
        "Every NISAR L2 GCOV acquisition over the study tiles: date, track, frame, direction, polarization mode, valid fraction per tile, and why a pass was excluded.",
        "PassesResponse",
      ),
      "/api/states": docGet(
        "getFieldStates",
        "Get every field's state on every used pass",
        "Compact matrix for animation: pass_ids, field_ids and one string per field with one character per pass: F flooded, D drained, U uncertain, - no observation.",
        "StatesResponse",
      ),
      "/api/fields": {
        get: {
          operationId: "listFields",
          summary: "List rice fields with their season verdicts",
          description: `Fields ordered by field_id, ${PAGE_SIZE} per page, optionally filtered by tile and AWD verdict. Summary columns are null until the run's season summary is published. Use total and page_size to page through.`,
          tags: ["Fields"],
          security: [],
          parameters: [
            { name: "tile", in: "query", required: false, description: "Only fields in this study tile (see GET /api/meta → tiles[].id).", schema: { type: "string", pattern: "^[a-z][a-z0-9]{0,15}$" }, example: "fazilka" },
            {
              name: "verdict",
              in: "query",
              required: false,
              description: "Only fields with this AWD season verdict.",
              schema: { type: "string", enum: ["consistent", "inconsistent", "not_enough_evidence"] },
            },
            { name: "page", in: "query", required: false, description: "1-based page number.", schema: { type: "integer", minimum: 1, maximum: 9_999_999, default: 1 } },
            { $ref: "#/components/parameters/IfNoneMatch" },
          ],
          responses: {
            "200": jsonBody("FieldsPageResponse", "One page of fields (an empty page past the end).", { ETag: { $ref: "#/components/headers/ETag" } }),
            "304": err("NotModified"),
            "400": err("BadRequest"),
            "503": err("Unavailable"),
            "500": err("Internal"),
          },
        },
      },
      "/api/fields/{id}": {
        get: {
          operationId: "getField",
          summary: "Get one field's polygon, observations and season summary",
          description:
            "Everything known about one field: its polygon and properties (area, rice share), every observation by pass time (radar backscatter OBSERVED, state INFERRED) and the season summary (AWD verdict with its reason, DSR signal).",
          tags: ["Fields"],
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, description: "Field id, `<tile>-<5 digits>`.", schema: { type: "string", pattern: "^[a-z][a-z0-9]{0,15}-[0-9]{5}$" }, example: exampleField },
            { $ref: "#/components/parameters/IfNoneMatch" },
          ],
          responses: {
            "200": jsonBody("FieldDetailResponse", "The field card.", { ETag: { $ref: "#/components/headers/ETag" } }),
            "304": err("NotModified"),
            "404": err("NotFound"),
            "503": err("Unavailable"),
            "500": err("Internal"),
          },
        },
      },
      "/api/detectability": docGet(
        "getDetectability",
        "Get what the real pass dates can detect",
        "A seeded simulation over the run's actual pass dates: how often a field practicing AWD is caught drained, how often a continuously flooded field is falsely flagged, k_star, the parameters (ASSUMED, each with its citation) and a one-sentence summary.",
        "DetectabilityResponse",
      ),
      "/api/checks": docGet(
        "getChecks",
        "Get the season-shape check, OPERA cross-check and district table",
        "Independent checks: the season shape (flooded share by stage), a tile-level cross-check against NASA OPERA surface water, and the district table comparing tile DSR signal with government DSR figures (null until built).",
        "ChecksResponse",
      ),
      "/api/provenance": docGet(
        "getProvenance",
        "Get granule ids, artifact hashes and the decomposition check",
        "Where every number came from: the NISAR granule ids and subset hashes, sha256 of every run artifact, the git commit and the reference check of the polarimetric decomposition.",
        "ProvenanceResponse",
      ),
      "/api/audit": {
        post: {
          operationId: "createAudit",
          summary: "Rank claimed rice fields for inspection",
          description:
            `Upload a GeoJSON FeatureCollection of claims (Point, Polygon or MultiPolygon; properties.claimed lists awd and/or dsr). ` +
            `Each claim is matched to a mapped field, weighted by its verdict and area, and ${"`budget`"} of them are picked: 80% by score, 20% at random, stratified by district (CONTRACTS.md B6). ` +
            `The same body against the same run always gives the same audit_id and ranking. Body at most ${MAX_BODY_BYTES} bytes, at most ${MAX_CLAIMS} claims, budget 1-500. ` +
            `Only the ranking is stored, never the uploaded geometry; do not put names or other personal details in uploads. ${rate} ` +
            `Every response carries the notice "${AUDIT_NOTICE}"`,
          tags: ["Audits"],
          security: [],
          requestBody: {
            required: true,
            description: "Claims, an inspection budget and an optional seed, as UTF-8 JSON.",
            content: { "application/json": { schema: ref("AuditRequest") } },
          },
          responses: {
            "201": jsonBody("AuditResponse", "Ranked and stored; Location names the stored audit.", {
              Location: { $ref: "#/components/headers/Location" },
              "x-audit-stored": { $ref: "#/components/headers/AuditStored" },
            }),
            "200": jsonBody("AuditResponse", "Already stored (same body, same run), or ranked but not stored because the daily store budget is spent (x-audit-stored: false).", {
              "x-audit-stored": { $ref: "#/components/headers/AuditStored" },
            }),
            "400": err("BadRequest"),
            "413": err("TooLarge"),
            "429": err("RateLimited"),
            "503": err("Unavailable"),
            "500": err("Internal"),
          },
        },
      },
      "/api/audit/{audit_id}": {
        get: {
          operationId: "getAudit",
          summary: "Get a stored inspection ranking",
          description: `A ranking stored by POST /api/audit, by its content-addressed id. Immutable for a real run; kept ${AUDIT_TTL_SECONDS / 86_400} days, and only while its run is live.`,
          tags: ["Audits"],
          security: [],
          parameters: [{ name: "audit_id", in: "path", required: true, description: "`a_` and 16 hex digits.", schema: { type: "string", pattern: "^a_[0-9a-f]{16}$" } }],
          responses: {
            "200": jsonBody("AuditResponse", "The stored ranking."),
            "400": err("BadRequest"),
            "404": err("NotFound"),
            "503": err("Unavailable"),
            "500": err("Internal"),
          },
        },
      },
      "/tiles/runs/{run_id}/{file}": tileOp("getRunFile", "Download a run file (fields GeoJSON, PMTiles, sample claims)", "file", "^(fields\\.geojson|fields\\.pmtiles|claims\\.sample\\.geojson)$"),
      "/tiles/runs/{run_id}/overlays/{file}": tileOp("getRunOverlay", "Download a per-pass radar overlay image or its index", "file", "^[A-Za-z0-9_.-]+\\.(png|json)$"),
      "/tiles/runs/{run_id}/hist/{file}": tileOp("getRunHistogram", "Download a backscatter histogram image by season stage", "file", "^[A-Za-z0-9_.-]+\\.png$"),
    },
    components: {
      schemas,
      parameters: {
        IfNoneMatch: { name: "If-None-Match", in: "header", required: false, description: "An ETag from an earlier response; a match answers 304.", schema: { type: "string" } },
        Range: { name: "Range", in: "header", required: false, description: "One byte range, e.g. `bytes=0-16383`, `bytes=1000-` or `bytes=-512`.", schema: { type: "string", pattern: "^bytes=" } },
        IfRange: { name: "If-Range", in: "header", required: false, description: "Apply Range only if the file's ETag still matches.", schema: { type: "string" } },
        RunId: { name: "run_id", in: "path", required: true, description: "A published run id (the live one is in GET /api/health).", schema: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }, example: opts.exampleRunId },
      },
      headers: {
        ETag: { description: "Validator for If-None-Match.", schema: { type: "string" } },
        CacheControl: { description: "public, max-age=60, stale-while-revalidate=600 for live-run documents.", schema: { type: "string" } },
        Location: { description: "Path of the stored audit, /api/audit/{audit_id}.", schema: { type: "string" } },
        AuditStored: { description: "true if the ranking was stored, false if only ranked.", schema: { type: "string", enum: ["true", "false"] } },
        RetryAfter: { description: "Seconds until another audit is allowed.", schema: { type: "integer", minimum: 1 } },
        ContentRange: { description: "bytes start-end/size of the returned part.", schema: { type: "string" } },
      },
      responses: {
        FileBytes: {
          description: "The whole file.",
          headers: { ETag: { $ref: "#/components/headers/ETag" }, "Accept-Ranges": { schema: { type: "string", const: "bytes" } } },
          content: {
            "application/geo+json": { schema: { type: "object" } },
            "application/json": { schema: { type: "object" } },
            "image/png": { schema: { type: "string", contentEncoding: "binary" } },
            "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } },
          },
        },
        PartialBytes: {
          description: "The requested byte range.",
          headers: { "Content-Range": { $ref: "#/components/headers/ContentRange" }, ETag: { $ref: "#/components/headers/ETag" } },
          content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } } },
        },
      },
    },
  });
}

/** Drop schema components nothing references (a schema file's root when only its $defs are used). */
function pruneSchemas(spec: Obj): Obj {
  const components = spec["components"] as Obj;
  const schemas = components["schemas"] as Record<string, Json>;
  const refs = (node: Json, into: Set<string>) => {
    if (Array.isArray(node)) node.forEach((n) => refs(n, into));
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")) into.add(v.slice(21));
        else refs(v, into);
      }
  };
  const used = new Set<string>();
  refs({ ...spec, components: { ...components, schemas: {} } }, used);
  const queue = [...used];
  while (queue.length) {
    const name = queue.pop()!;
    const more = new Set<string>();
    refs(schemas[name] ?? null, more);
    for (const m of more) if (!used.has(m)) used.add(m), queue.push(m);
  }
  components["schemas"] = Object.fromEntries(Object.entries(schemas).filter(([k]) => used.has(k)));
  return spec;
}

/** Every API operation as `METHOD path` with `{param}` placeholders, for the coverage test. */
export function operations(spec: Obj): string[] {
  const paths = spec["paths"] as Record<string, Record<string, unknown>>;
  return Object.entries(paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
}

/** A small YAML 1.2 emitter for JSON data (block style; strings JSON-quoted when needed, which YAML accepts). */
export function toYaml(value: Json, indent = 0): string {
  const pad = "  ".repeat(indent);
  const scalar = (v: Json): string => {
    if (v === null) return "null";
    if (typeof v === "string") return /^[A-Za-z_][A-Za-z0-9_ .,/()-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/[ .]$/.test(v) && !v.includes(": ") && !v.includes(" #") ? v : JSON.stringify(v);
    return String(v);
  };
  const key = (k: string) => (/^[A-Za-z_$/{][A-Za-z0-9_$/{}.-]*$/.test(k) && !/^(true|false|null|yes|no|on|off)$/i.test(k) ? k : JSON.stringify(k));
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((v) => (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length) ? `${pad}-\n${toYaml(v, indent + 1)}` : `${pad}- ${toYaml(v, 0)}`))
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key(k)}:\n${toYaml(v, indent + 1)}`;
        return `${pad}${key(k)}: ${toYaml(v, 0)}`;
      })
      .join("\n");
  }
  return scalar(value);
}
