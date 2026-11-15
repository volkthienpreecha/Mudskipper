/**
 * The Mudskipper API: one Hono app for every CONTRACTS.md B6 route plus GET /api/states (B3.13), served as
 * Cloudflare Pages Functions (functions/api/[[path]].ts, functions/tiles/[[path]].ts).
 *
 * Every success is JSON with the C0 header {v, run_id, fixture} (except /tiles/*); every failure is
 * `{"error":{"code","message"}}` (schema api/error). Response shapes are pinned by contracts/schemas/api and
 * checked against contracts/fixtures/api in the tests.
 */
import { Hono, type Context } from "hono";
import { DOC_NAMES, AUDIT_ID, TILE_ID, VERDICTS, type DocName, type Live } from "./contracts.ts";
import type { AppEnv } from "./env.ts";
import { auditId, defaultSeed } from "./crypto.ts";
import { ApiError, badRequest, errorBody, notFound } from "./http/errors.ts";
import { CACHE, applySecurityHeaders, etagMatches } from "./http/headers.ts";
import { parseAuditBody, readBodyCapped, toApiError } from "./audit/validate.ts";
import { RankError, defaultRank, type RankFn } from "./audit/rank.ts";
import { selectBackend, type Backend } from "./backend.ts";
import { fieldsPage, header } from "./shapes.ts";
import { serveTile } from "./tiles.ts";

export interface AppOptions {
  /** The ranking implementation. Defaults to core's `rank`; tests inject doubles and failures. */
  rank?: RankFn;
  /** Clock, for tests. */
  now?: () => Date;
}

/** Routes and their methods, for /api, 405 answers and the placeholder page. */
export const ROUTES: { path: string; methods: string[]; description: string }[] = [
  { path: "/api/health", methods: ["GET"], description: "Liveness and which run is live" },
  { path: "/api/meta", methods: ["GET"], description: "Season, stages, gap, tiles, counts, asset URLs, Limits text" },
  { path: "/api/story", methods: ["GET"], description: "Headline and hero field for the Story screen" },
  { path: "/api/passes", methods: ["GET"], description: "Every NISAR pass, used or excluded" },
  { path: "/api/states", methods: ["GET"], description: "Every field's state on every used pass (map animation)" },
  { path: "/api/fields", methods: ["GET"], description: "Fields with verdicts; ?tile=&verdict=&page=" },
  { path: "/api/fields/:id", methods: ["GET"], description: "One field: polygon, observations, season summary" },
  { path: "/api/detectability", methods: ["GET"], description: "What the real pass dates can detect" },
  { path: "/api/checks", methods: ["GET"], description: "Season shape, OPERA cross-check, district table" },
  { path: "/api/provenance", methods: ["GET"], description: "Granules, artifact hashes, decomposition check" },
  { path: "/api/audit", methods: ["POST"], description: "Rank claims for inspection (GeoJSON, ≤ 5 MB, ≤ 5,000 claims)" },
  { path: "/api/audit/:id", methods: ["GET"], description: "A stored ranking" },
  { path: "/tiles/*", methods: ["GET"], description: "Run files (GeoJSON, PMTiles, overlays) with Range → 206" },
];

const DOC_ROUTES: Record<string, DocName> = Object.fromEntries(DOC_NAMES.map((n) => [`/api/${n}`, n]));

function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

function json(body: unknown, status: number, cache: string, extra: Record<string, string> = {}): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": cache, ...extra });
  return new Response(JSON.stringify(body), { status, headers: h });
}

function errorResponse(e: ApiError): Response {
  return json(errorBody(e.code, e.message), e.status, CACHE.none, e.headers);
}

/** Live-scoped GET: ETag from the run's content version, 304 on a match. */
async function liveJson(c: Context<AppEnv>, backend: Backend, live: Live, body: unknown): Promise<Response> {
  const version = await backend.repo.version(live);
  const etag = `W/"${live.run_id}-${version.slice(0, 16)}"`;
  if (etagMatches(c.req.header("if-none-match") ?? null, etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": CACHE.live } });
  }
  return json(body, 200, CACHE.live, { etag });
}

function parseFieldQuery(url: URL): { tile: string | null; verdict: string | null; page: number } {
  const param = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v === "" ? null : v;
  };
  const tile = param("tile");
  const verdict = param("verdict");
  const pageRaw = param("page");
  if (tile !== null && !TILE_ID.test(tile)) throw badRequest(`tile must match ${TILE_ID.source}.`);
  if (verdict !== null && !(VERDICTS as readonly string[]).includes(verdict)) {
    throw badRequest(`verdict must be one of ${VERDICTS.join(", ")}.`);
  }
  if (pageRaw !== null && !/^[1-9][0-9]{0,6}$/.test(pageRaw)) throw badRequest("page must be a positive integer.");
  return { tile, verdict, page: pageRaw === null ? 1 : Number(pageRaw) };
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const rank = options.rank ?? defaultRank;
  const now = options.now ?? (() => new Date());
  const app = new Hono<AppEnv>();
  const backendOf = (c: Context<AppEnv>) => selectBackend(c.env, new URL(c.req.url).origin);

  // Security headers on every Function response (static assets get theirs from _headers).
  app.use("*", async (c, next) => {
    await next();
    applySecurityHeaders(c.res.headers);
  });

  // CORS preflight for POST /api/audit from other origins (the app in local dev).
  app.options("*", () =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type, if-none-match, range",
        "access-control-max-age": "86400",
      },
    }),
  );

  const index = () =>
    json(
      {
        v: 1,
        name: "Mudskipper API",
        description: "NISAR radar evidence of rice-field drainage, field by field. NASA Space Apps 2026.",
        contract: "https://github.com/volkthienpreecha/Mudskipper/blob/main/contracts/CONTRACTS.md#b6-http-api",
        endpoints: ROUTES,
      },
      200,
      "public, max-age=300",
    );
  app.get("/api", index);
  app.get("/api/", index);

  app.get("/api/health", async (c) => {
    const live = await backendOf(c).repo.live();
    return json({ ...header(live.run_id, live.fixture), ok: true, time: isoSeconds(now()) }, 200, CACHE.none);
  });

  for (const [path, name] of Object.entries(DOC_ROUTES)) {
    app.get(path, async (c) => {
      const backend = backendOf(c);
      const live = await backend.repo.live();
      const doc = await backend.repo.doc(live, name);
      if (!doc) throw notFound(`Run ${live.run_id} has no ${name} yet.`);
      return liveJson(c, backend, live, doc);
    });
  }

  app.get("/api/fields", async (c) => {
    const backend = backendOf(c);
    const q = parseFieldQuery(new URL(c.req.url));
    const live = await backend.repo.live();
    const rows = await backend.repo.fieldRows(live);
    return liveJson(c, backend, live, fieldsPage(live.run_id, live.fixture, rows, q));
  });

  app.get("/api/fields/:id", async (c) => {
    const backend = backendOf(c);
    const id = c.req.param("id");
    const live = await backend.repo.live();
    const detail = await backend.repo.field(live, id);
    if (!detail) throw notFound(`No field with id ${id} in run ${live.run_id}.`);
    return liveJson(c, backend, live, detail);
  });

  app.post("/api/audit", async (c) => {
    const backend = backendOf(c);
    if (!backend.audits) {
      throw new ApiError(503, "storage_unavailable", "Audit storage is not configured on this deployment.");
    }
    const bytes = await readBodyCapped(c.req.raw);
    const { request, inputHash } = await parseAuditBody(bytes);
    const live = await backend.repo.live();
    const seed = request.seed ?? defaultSeed(inputHash);
    const id = await auditId(live.run_id, inputHash, request.budget, seed);
    const location = { location: `/api/audit/${id}` };

    const existing = await backend.audits.get(id);
    if (existing) return json(existing, 200, CACHE.none, location);

    const inputs = await backend.repo.rankInputs(live);
    let result;
    try {
      result = await rank(request, inputHash, inputs.fields, inputs.summaries, live.run_id, isoSeconds(now()), live.fixture);
    } catch (e) {
      if (e instanceof RankError) throw toApiError(e);
      throw e;
    }
    if (result.audit_id !== id) {
      // core and the platform disagree on CONTRACTS.md B6 step 8; store under core's id and say so in the logs.
      console.error(`audit_id mismatch: platform ${id}, ranking ${result.audit_id}`);
    }
    const stored = await backend.audits.put(result);
    return json(stored, 201, CACHE.none, { location: `/api/audit/${stored.audit_id}` });
  });

  app.get("/api/audit/:id", async (c) => {
    const id = c.req.param("id");
    if (!AUDIT_ID.test(id)) throw badRequest(`audit id must match ${AUDIT_ID.source}.`);
    const backend = backendOf(c);
    if (!backend.audits) throw new ApiError(503, "storage_unavailable", "Audit storage is not configured on this deployment.");
    const stored = await backend.audits.get(id);
    if (!stored) throw notFound(`No audit with id ${id}.`);
    return json(stored, 200, CACHE.immutable);
  });

  app.get("/tiles/*", async (c) => serveTile(c.req.raw, c.env, backendOf(c).tiles));

  // Known paths with the wrong method: 405 with Allow. Everything else under /api or /tiles: 404.
  const allowed = (path: string): string[] | null => {
    for (const r of ROUTES) {
      const re = new RegExp("^" + r.path.replace(/:id/g, "[^/]+").replace("/*", "/.+") + "$");
      if (re.test(path)) return r.methods;
    }
    return null;
  };
  app.all("*", (c) => {
    const methods = allowed(new URL(c.req.url).pathname);
    if (methods && !methods.includes(c.req.method)) {
      const allow = methods.includes("GET") ? [...methods, "HEAD", "OPTIONS"] : [...methods, "OPTIONS"];
      throw new ApiError(405, "method_not_allowed", `${c.req.method} is not allowed here; use ${methods.join(" or ")}.`, {
        allow: allow.join(", "),
      });
    }
    throw notFound(`No route ${c.req.method} ${new URL(c.req.url).pathname}. See /api for the list.`);
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return errorResponse(err);
    // Never log request bodies (uploads may carry anything); the message and path are enough.
    console.error(`unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
    const res = errorResponse(new ApiError(500, "internal", "Internal error. The request was not stored."));
    applySecurityHeaders(res.headers);
    return res;
  });

  app.notFound((c) => errorResponse(notFound(`No route ${c.req.method} ${new URL(c.req.url).pathname}.`)));

  return app;
}

/** The deployed app (ranking: core's `rank`). */
export const app = createApp();
export default app;
