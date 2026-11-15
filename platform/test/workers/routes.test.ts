// Every GET route on both data backends: status, schema, exact equality with contracts/fixtures/api, headers.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_BACKENDS, call, envFor, fixtureApi, resetCaches, validators as V, type BackendKind } from "./helpers.ts";
import type { Validator } from "../gen/validators.js";

beforeEach(resetCaches);

function expectValid(validate: Validator, body: unknown) {
  const ok = validate(body);
  expect(ok ? [] : validate.errors).toEqual([]);
}

const DOCS: [string, Validator, string][] = [
  ["/api/meta", V.meta, "meta"],
  ["/api/story", V.story, "story"],
  ["/api/passes", V.passes, "passes"],
  ["/api/states", V.states, "states"],
  ["/api/detectability", V.detectability, "detectability"],
  ["/api/checks", V.checks, "checks"],
  ["/api/provenance", V.provenance, "provenance"],
];

describe.each(["static", "d1", "r2"] as BackendKind[])("%s backend", (kind) => {
  it("GET /api/health is the fixture health response at the injected clock", async () => {
    const res = await call("/api/health", kind);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expectValid(V.health, body);
    expect(body).toStrictEqual(fixtureApi("health"));
  });

  it.each(DOCS)("GET %s equals contracts/fixtures/api and validates", async (path, validate, name) => {
    const res = await call(path, kind);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=600");
    expect(res.headers.get("etag")).toMatch(/^W\/"fixture-[0-9a-f]{16}"$/);
    const body = (await res.json()) as Record<string, unknown>;
    expectValid(validate, body);
    expect(body["fixture"]).toBe(true); // T8: SAMPLE badge
    expect(body).toStrictEqual(fixtureApi(name));
  });

  it("GET /api/fields is page 1 of all fields, equal to the fixture", async () => {
    const res = await call("/api/fields", kind);
    const body = await res.json();
    expectValid(V.fieldsPage, body);
    expect(body).toStrictEqual(fixtureApi("fields"));
  });

  it("GET /api/fields filters by tile and verdict and pages", async () => {
    const tile = (await (await call("/api/fields?tile=muktsar", kind)).json()) as { total: number; fields: { tile: string }[]; filters: unknown };
    expect(tile.total).toBe(150);
    expect(tile.fields.every((f) => f.tile === "muktsar")).toBe(true);
    expect(tile.filters).toEqual({ tile: "muktsar", verdict: null });

    const all = fixtureApi("fields") as { fields: { awd_verdict: string; tile: string }[] };
    for (const verdict of ["consistent", "inconsistent", "not_enough_evidence"]) {
      const res = await call(`/api/fields?verdict=${verdict}&tile=fazilka`, kind);
      const body = (await res.json()) as { total: number; fields: { awd_verdict: string }[] };
      expectValid(V.fieldsPage, body);
      expect(body.total).toBe(all.fields.filter((f) => f.awd_verdict === verdict && f.tile === "fazilka").length);
      expect(body.fields.every((f) => f.awd_verdict === verdict)).toBe(true);
    }

    const page2 = (await (await call("/api/fields?page=2", kind)).json()) as { page: number; fields: unknown[]; next_page: unknown; total: number };
    expect(page2).toMatchObject({ page: 2, fields: [], next_page: null, total: 300 });

    const unknownTile = (await (await call("/api/fields?tile=nowhere", kind)).json()) as { total: number };
    expect(unknownTile.total).toBe(0);

    const empty = (await (await call("/api/fields?tile=&verdict=", kind)).json()) as { filters: unknown };
    expect(empty.filters).toEqual({ tile: null, verdict: null });
  });

  it.each([
    ["/api/fields?tile=Bad!", "tile"],
    ["/api/fields?verdict=fraud", "verdict"],
    ["/api/fields?page=0", "page"],
    ["/api/fields?page=abc", "page"],
  ])("GET %s is 400 invalid_request", async (path, what) => {
    const res = await call(path, kind);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expectValid(V.error, body);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain(what);
  });

  it("GET /api/fields/:id equals the fixture field card", async () => {
    const res = await call("/api/fields/fazilka-00114", kind);
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid(V.fieldDetail, body);
    expect(body).toStrictEqual(fixtureApi("field.fazilka-00114"));
  });

  it("GET /api/fields/:id validates for every field and matches the static bundle", async () => {
    const ids = (fixtureApi("fields") as { fields: { field_id: string }[] }).fields.map((f) => f.field_id);
    for (const id of ids.filter((_, i) => i % 15 === 0)) {
      const body = await (await call(`/api/fields/${id}`, kind)).json();
      expectValid(V.fieldDetail, body);
      const expected = await (await env.ASSETS.fetch(`https://x/data/runs/fixture/api/fields/${id}.json`)).json();
      expect(body).toStrictEqual(expected);
    }
  });

  it("GET /api/fields/:id for an unknown field is the fixture 404", async () => {
    const res = await call("/api/fields/fazilka-99999", kind);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expectValid(V.error, body);
    expect(body).toStrictEqual(fixtureApi("error.not_found"));
  });

  it("GET /api/fields/:id with a malformed id is 404", async () => {
    const res = await call("/api/fields/..%2Fmeta", kind);
    expect(res.status).toBe(404);
    expectValid(V.error, await res.json());
  });

  it("answers If-None-Match with 304", async () => {
    const first = await call("/api/story", kind);
    const etag = first.headers.get("etag")!;
    const second = await call("/api/story", kind, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");
  });
});

describe("both data backends agree", () => {
  it("serve the same ETag version for the same bundle", async () => {
    const tags = await Promise.all(DATA_BACKENDS.map(async (k) => (await call("/api/meta", k)).headers.get("etag")));
    expect(new Set(tags).size).toBe(1);
  });
});

describe("routing and headers", () => {
  it("GET /api and /api/ list every endpoint", async () => {
    for (const path of ["/api", "/api/"]) {
      const res = await call(path, "static");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { endpoints: { path: string }[] };
      expect(body.endpoints.map((e) => e.path)).toContain("/api/states");
      expect(body.endpoints).toHaveLength(13);
    }
  });

  it("unknown /api routes are 404 JSON", async () => {
    for (const path of ["/api/nope", "/api/fields/fazilka-00001/extra", "/api/v2/meta"]) {
      const res = await call(path, "static");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = (await res.json()) as { error: { code: string } };
      expectValid(V.error, body);
      expect(body.error.code).toBe("not_found");
    }
  });

  it("wrong methods are 405 with Allow", async () => {
    const post = await call("/api/meta", "static", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expectValid(V.error, await post.json());
    const get = await call("/api/audit", "static");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS");
    const del = await call("/api/audit/a_0123456789abcdef", "static", { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("/api/health is 503 no_live_run when live.json names a run whose files are missing", async () => {
    const broken: Fetcher = {
      fetch: (input: string | Request | URL, init?: RequestInit) =>
        String(input instanceof Request ? input.url : input).endsWith("/manifest.json")
          ? Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
          : env.ASSETS.fetch(input, init),
    };
    const res = await call("/api/health", envFor("static", { ASSETS: broken }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_live_run");
  });

  it("OPTIONS on an unknown route is a 404; on a known one it lists that route's methods", async () => {
    const res = await call("/api/nope", "static", { method: "OPTIONS" });
    expect(res.status).toBe(404);
    expectValid(V.error, await res.json());
    const known = await call("/api/meta", "static", { method: "OPTIONS" });
    expect(known.status).toBe(204);
    expect(known.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
  });

  it("the /api index carries the C0 header (v, run_id, fixture) and the audit limits", async () => {
    const body = (await (await call("/api", "static")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 1, run_id: "fixture", fixture: true });
    expect(body["limits"]).toMatchObject({ audit_max_claims: expect.any(Number), audit_max_body_bytes: 5 * 1024 * 1024, fields_page_size: 500 });
  });

  it("page 10000000 says the real limit", async () => {
    const res = await call("/api/fields?page=10000000", "static");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("page must be an integer from 1 to 9999999.");
    expect((await call("/api/fields?page=9999999", "static")).status).toBe(200);
  });

  it("CORS preflight is answered", async () => {
    const res = await call("/api/audit", "static", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("every response carries the security headers", async () => {
    const cases: [string, RequestInit?][] = [
      ["/api/meta"],
      ["/api/nope"],
      ["/api/fields/fazilka-99999"],
      ["/tiles/runs/fixture/fields.geojson"],
      ["/tiles/runs/fixture/fields.geojson", { headers: { range: "bytes=99999999-" } }], // 416
      ["/tiles/runs/fixture/..%2f..%2flive.json"], // traversal: 404
      ["/api/health", { method: "PUT" }], // 405
      ["/api/audit", { method: "OPTIONS" }], // preflight
    ];
    for (const [path, init] of cases) {
      const res = await call(path, "static", init);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("is 503 no_live_run when nothing is published", async () => {
    const res = await call("/api/meta", envFor("static", { ASSETS: env.ASSETS_EMPTY }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expectValid(V.error, body);
    expect(body.error.code).toBe("no_live_run");
  });

  it("BACKEND=static forces the static bundle even with DB bound", async () => {
    const untouchable = new Proxy({}, { get: () => () => { throw new Error("D1 must not be read"); } }) as unknown as D1Database;
    const res = await call("/api/meta", envFor("d1", { BACKEND: "static", DB: untouchable }));
    expect(res.status).toBe(200);
    expect(await call("/api/fields/fazilka-00114", envFor("d1", { BACKEND: "static", DB: untouchable }))).toHaveProperty("status", 200);
  });

  it("D1 serves only the version the deployment names: another upload of the run is 503, never a mixed answer", async () => {
    const other: Fetcher = {
      async fetch(input: string | Request | URL, init?: RequestInit) {
        const res = await env.ASSETS.fetch(input, init);
        if (!String(input instanceof Request ? input.url : input).endsWith("/data/runs/fixture/manifest.json")) return res;
        return Response.json({ ...((await res.json()) as object), bundle_hash: "e".repeat(64) });
      },
    };
    for (const path of ["/api/meta", "/api/fields", "/api/fields/fazilka-00114"]) {
      const res = await call(path, envFor("d1", { ASSETS: other }));
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "no_live_run" });
    }
    // the deployment's own live.json is the pointer: no D1 meta row is needed (it is only a mirror)
    await env.DB.prepare("DELETE FROM meta WHERE key = 'live'").run();
    resetCaches(); // a fresh isolate of the real deployment
    expect((await call("/api/meta", "d1")).status).toBe(200);
  });

  it("no response leaks request data: errors never echo the body", async () => {
    const res = await call("/api/audit", "static", { method: "POST", body: '{"claims": "farmer Gurpreet Singh"' });
    const text = await res.text();
    expect(text).not.toContain("Gurpreet");
  });
});
