/**
 * The Mudskipper API: one Hono app for every CONTRACTS.md B6 route plus GET /api/states (B3.13), served as
 * Cloudflare Pages Functions (functions/api/[[path]].ts, functions/tiles/[[path]].ts).
 *
 * Every success is JSON with the C0 header {v, run_id, fixture} (except /tiles/*); every failure is
 * `{"error":{"code","message"}}` (schema api/error). Response shapes are pinned by contracts/schemas/api and
 * checked against contracts/fixtures/api in the tests.
 */
import { Hono, type Context } from "hono";
import { MAX_BODY_BYTES, MAX_CLAIMS, parseFieldsQuery, QueryError } from "@mudskipper/core";
import { PAGE_SIZE } from "./limits.ts";
import { DOC_NAMES, AUDIT_ID, type DocName, type Live } from "./contracts.ts";
import type { AppEnv } from "./env.ts";
import { auditId, defaultSeed } from "./crypto.ts";
import { ApiError, badRequest, errorBody, notFound } from "./http/errors.ts";
import { CACHE, applySecurityHeaders, etagMatches } from "./http/headers.ts";
import { parseAuditBody, readBodyCapped, toApiError } from "./audit/validate.ts";
import { RankError, defaultRank, type RankFn } from "./audit/rank.ts";
import { clientKey, defaultRateLimiter, defaultStoreBudget, type RateLimiter, type StoreBudget } from "./audit/guard.ts";
import type { KvAuditStore } from "./audit/store.ts";
import { selectBackend, type Backend } from "./backend.ts";
import type { Body } from "./repo/types.ts";
import { header, type FieldQuery } from "./shapes.ts";
import { serveTile } from "./tiles.ts";

export interface AppOptions {
  /** The ranking implementation. Defaults to core's `rank`; tests inject doubles and failures. */
  rank?: RankFn;
  /** Clock, for tests. */
  now?: () => Date;
  /** POST /api/audit rate limit per client IP, IPv6 per /64 (default: 20 at once, then one every 3 s, per isolate). */
  limiter?: RateLimiter;
  /** Daily stored-audit budget shared through KV (default: 800 a day). */
  budget?: StoreBudget;
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

const ROUTE_PATTERNS = [
  { re: /^\/api\/?$/, methods: ["GET"] },
  ...ROUTES.map((r) => ({ re: new RegExp("^" + r.path.replace(/:id/g, "[^/]+").replace("/*", "/.+") + "$"), methods: r.methods })),
];

/** The methods a known route answers, or null for a path no route serves. */
function allowedMethods(path: string): string[] | null {
  return ROUTE_PATTERNS.find((r) => r.re.test(path))?.methods ?? null;
}

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

/**
 * Live-scoped GET: ETag from the run's content version, 304 on a match. The body is the exact response text
 * from the repository (a stream for the static bundle), sent without parsing it.
 */
async function liveJson(c: Context<AppEnv>, backend: Backend, live: Live, body: Body): Promise<Response> {
  const version = await backend.repo.version(live);
  const etag = `W/"${live.run_id}-${version.slice(0, 16)}"`;
  if (etagMatches(c.req.header("if-none-match") ?? null, etag)) {
    if (typeof body !== "string") await body.cancel();
    return new Response(null, { status: 304, headers: { etag, "cache-control": CACHE.live } });
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": CACHE.live, etag },
  });
}

/** GET /api/fields query, with the checks the fixtures client shares (core/src/query.ts). */
function parseFieldQuery(url: URL): FieldQuery {
  const p = url.searchParams;
  try {
    return parseFieldsQuery({ tile: p.get("tile"), verdict: p.get("verdict"), page: p.get("page") });
  } catch (e) {
    if (e instanceof QueryError) throw badRequest(e.message);
    throw e;
  }
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const rank = options.rank ?? defaultRank;
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter ?? defaultRateLimiter();
  const budget = options.budget ?? defaultStoreBudget();
  const app = new Hono<AppEnv>();
  const backendOf = (c: Context<AppEnv>) => selectBackend(c.env, new URL(c.req.url).origin);

  // Security headers on every Function response (static assets get theirs from _headers).
  app.use("*", async (c, next) => {
    await next();
    applySecurityHeaders(c.res.headers);
  });

  // CORS preflight for POST /api/audit from other origins (the app in local dev). Only known routes answer;
  // anything else is the same JSON 404 a GET gets.
  app.options("*", (c) => {
    const methods = allowedMethods(new URL(c.req.url).pathname);
    if (!methods) throw notFound(`No route ${new URL(c.req.url).pathname}. See /api for the list.`);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": [...methods, ...(methods.includes("GET") ? ["HEAD"] : []), "OPTIONS"].join(", "),
        "access-control-allow-headers": "content-type, if-none-match, if-match, range",
        "access-control-max-age": "86400",
      },
    });
  });

  // The index carries the C0 header like every other response, and this deployment's audit limits.
  const index = async (c: Context<AppEnv>) => {
    const live = await backendOf(c).repo.live();
    return json(
      {
        ...header(live.run_id, live.fixture),
        name: "Mudskipper API",
        description: "NISAR radar evidence of rice-field drainage, field by field. NASA Space Apps 2026.",
        contract: "https://github.com/volkthienpreecha/Mudskipper/blob/main/contracts/CONTRACTS.md#b6-http-api",
        limits: { audit_max_claims: MAX_CLAIMS, audit_max_body_bytes: MAX_BODY_BYTES, fields_page_size: PAGE_SIZE },
        endpoints: ROUTES,
      },
      200,
      CACHE.live,
    );
  };
  app.get("/api", index);
  app.get("/api/", index);

  // ok only when the live run's data is actually there: version() reads its manifest (503 no_live_run if not).
  app.get("/api/health", async (c) => {
    const backend = backendOf(c);
    const live = await backend.repo.live();
    await backend.repo.version(live);
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
    return liveJson(c, backend, live, await backend.repo.fieldsPage(live, q));
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
    const audits = backend.audits;
    const client = clientKey(c.req.header("cf-connecting-ip"));
    const turn = limiter.take(client, now().getTime());
    if (!turn.ok) {
      await c.req.raw.body?.cancel();
      throw new ApiError(429, "rate_limited", `Too many audits from this address; retry in ${turn.retryAfter} s.`, {
        "retry-after": String(turn.retryAfter),
      });
    }
    const bytes = await readBodyCapped(c.req.raw);
    const { request, inputHash } = await parseAuditBody(bytes);
    const live = await backend.repo.live();
    const version = await backend.repo.version(live);
    const seed = request.seed ?? defaultSeed(inputHash);
    const id = await auditId(live.run_id, inputHash, request.budget, seed);
    const location = { location: `/api/audit/${id}` };

    const existing = await audits.get(id, version);
    if (existing) return json(existing, 200, CACHE.none, location);

    const inputs = await backend.repo.rankInputs(live);
    let result;
    try {
      result = await rank(request, inputHash, inputs.index, inputs.summaries, live.run_id, isoSeconds(now()), live.fixture);
    } catch (e) {
      if (e instanceof RankError) throw toApiError(e);
      throw e;
    }
    if (result.audit_id !== id) {
      // core and the platform disagree on CONTRACTS.md B6 step 8; store under core's id and say so in the logs.
      console.error(`audit_id mismatch: platform ${id}, ranking ${result.audit_id}`);
    }
    // KV allows 1,000 writes a day: over the shared daily budget, or if KV refuses the write, rank without
    // storing (200, x-audit-stored: false, no Location) instead of failing the request (src/audit/guard.ts).
    const kv = audits.kind === "kv" ? (audits as KvAuditStore).kv : null;
    const unstored = () => json(result, 200, CACHE.none, { "x-audit-stored": "false" });
    if (kv && !(await budget.allows(kv, now().getTime()).catch(() => true))) return unstored();
    let stored;
    try {
      stored = await audits.put(result, version);
    } catch (e) {
      console.error(`audit store failed (${audits.kind}): ${(e as Error).message}`);
      return unstored();
    }
    if (kv) await budget.stored(kv, now().getTime()).catch((e: Error) => console.error(`audit budget counter: ${e.message}`));
    return json(stored, 201, CACHE.none, { location: `/api/audit/${stored.audit_id}`, "x-audit-stored": "true" });
  });

  app.get("/api/audit/:id", async (c) => {
    const id = c.req.param("id");
    if (!AUDIT_ID.test(id)) throw badRequest(`audit id must match ${AUDIT_ID.source}.`);
    const backend = backendOf(c);
    if (!backend.audits) throw new ApiError(503, "storage_unavailable", "Audit storage is not configured on this deployment.");
    const live = await backend.repo.live();
    const stored = await backend.audits.get(id, await backend.repo.version(live));
    if (!stored) throw notFound(`No audit with id ${id}.`);
    // A real run's audit never changes (content-addressed, K-308); the fixture run is regenerated in place.
    return json(stored, 200, live.fixture ? CACHE.live : CACHE.immutable);
  });

  app.get("/tiles/*", async (c) => serveTile(c.req.raw, c.env, backendOf(c).tiles));

  // Known paths with the wrong method: 405 with Allow. Everything else under /api or /tiles: 404.
  app.all("*", (c) => {
    const methods = allowedMethods(new URL(c.req.url).pathname);
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
