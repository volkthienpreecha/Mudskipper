/**
 * The typed API client in both modes. Fixtures mode must answer exactly as the API would (B6): every method
 * returns schema-valid data equal to the fixture files; api mode is checked against a mocked fetch.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, FIXTURE_FILES, PAGE_SIZE, type FixtureLoader, type MudskipperClient } from "../src/client.ts";
import type { AuditRequest, FieldCollection, FieldSummaryLine } from "../src/contracts.gen.ts";
import { nodeFixtureLoader } from "../src/fixtures-node.ts";
import { viteFixtureLoader } from "../src/fixtures-vite.ts";
import { assertSameJson, fixtureJson, fixtureJsonl, fixtureText } from "./helpers.ts";
import { schemaErrors } from "./schema.ts";

const expectValid = (schema: string, value: unknown): void => {
  const errs = schemaErrors(schema, value);
  expect(errs, `${schema}: ${errs.slice(0, 5).join("; ")}`).toEqual([]);
};

describe("test/schema.ts (the tiny validator)", () => {
  it("accepts every committed API fixture and rejects broken ones", () => {
    const names: Array<[string, string]> = [
      ["api/health.json", "api/health"],
      ["api/meta.json", "api/meta"],
      ["api/story.json", "api/story"],
      ["api/passes.json", "api/passes"],
      ["api/states.json", "api/states"],
      ["api/fields.json", "api/fields_page"],
      ["api/field.fazilka-00114.json", "api/field_detail"],
      ["api/detectability.json", "api/detectability"],
      ["api/checks.json", "api/checks"],
      ["api/provenance.json", "api/provenance"],
      ["api/audit.request.json", "api/audit_request"],
      ["api/audit.response.json", "api/audit_response"],
      ["api/error.not_found.json", "api/error"],
      ["run/fields.geojson", "fields"],
      ["run/claims.sample.geojson", "claims"],
    ];
    for (const [file, schema] of names) expectValid(schema, fixtureJson(file));
    for (const line of fixtureJsonl("run/observations.jsonl").slice(0, 50)) expectValid("observation", line);
    const broken = fixtureJson<Record<string, any>>("api/field.fazilka-00114.json");
    broken.summary.awd.verdict = "fraud";
    broken.observations[0].stage = "summer";
    broken.extra = 1;
    expect(schemaErrors("api/field_detail", broken).length).toBeGreaterThanOrEqual(3);
    const passes = fixtureJson<Record<string, any>>("api/passes.json");
    passes.passes[0].excluded_reason = "in_data_gap"; // used: true needs excluded_reason null (if/then)
    expect(schemaErrors("api/passes", passes)).not.toEqual([]);
    expect(schemaErrors("api/health", { ...fixtureJson<object>("api/health.json"), fixture: undefined })).not.toEqual([]);
  });
});

function fixtureClient(load: FixtureLoader = nodeFixtureLoader()): MudskipperClient {
  return createClient({ source: "fixtures", load });
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

describe("fixtures mode", () => {
  const client = fixtureClient();

  it("answers the plain endpoints with the committed responses", async () => {
    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [() => client.getHealth(), "api/health.json", "api/health"],
      [() => client.getMeta(), "api/meta.json", "api/meta"],
      [() => client.getStory(), "api/story.json", "api/story"],
      [() => client.getPasses(), "api/passes.json", "api/passes"],
      [() => client.getStates(), "api/states.json", "api/states"],
      [() => client.getDetectability(), "api/detectability.json", "api/detectability"],
      [() => client.getChecks(), "api/checks.json", "api/checks"],
      [() => client.getProvenance(), "api/provenance.json", "api/provenance"],
      [() => client.getClaimsSample(), "run/claims.sample.geojson", "claims"],
      [() => client.getFieldsGeoJson(), "run/fields.geojson", "fields"],
    ];
    for (const [call, file, schema] of cases) {
      const got = await call();
      assertSameJson(got, fixtureJson(file), file);
      expectValid(schema, got);
    }
    expect(client.source).toBe("fixtures");
  });

  it("getFields() equals api/fields.json; filters and pages like the API", async () => {
    const all = await client.getFields();
    assertSameJson(all, fixtureJson("api/fields.json"));
    expectValid("api/fields_page", all);

    const muk = await client.getFields({ tile: "muktsar" });
    expectValid("api/fields_page", muk);
    expect(muk.total).toBe(150);
    expect(muk.fields.every((f) => f.tile === "muktsar")).toBe(true);
    expect(muk.filters).toEqual({ tile: "muktsar", verdict: null });

    const summaries = fixtureJsonl<FieldSummaryLine>("run/field_summary.jsonl");
    for (const verdict of ["consistent", "inconsistent", "not_enough_evidence"] as const) {
      const page = await client.getFields({ verdict });
      expectValid("api/fields_page", page);
      expect(page.total).toBe(summaries.filter((s) => s.awd.verdict === verdict).length);
      expect(page.fields.every((f) => f.awd_verdict === verdict)).toBe(true);
    }
    const both = await client.getFields({ tile: "fazilka", verdict: "consistent" });
    expect(both.fields.every((f) => f.tile === "fazilka" && f.awd_verdict === "consistent")).toBe(true);

    const empty = await client.getFields({ page: 2 });
    expect([empty.fields.length, empty.total, empty.next_page, empty.page]).toEqual([0, 300, null, 2]);
    expect((await client.getFields({ tile: "nowhere" })).total).toBe(0);

    for (const bad of [{ page: 0 }, { page: 1.5 }, { tile: "Bad Tile" }, { verdict: "fraud" as never }]) {
      expect((await apiError(client.getFields(bad))).status).toBe(400);
    }
  });

  it("validates queries and ids exactly like the API (same codes and messages)", async () => {
    const client = fixtureClient();
    // an empty tile or verdict is no filter, as `?tile=&verdict=` is for the API
    const blank = await client.getFields({ tile: "", verdict: "" as never });
    expect(blank.filters).toEqual({ tile: null, verdict: null });
    expect(blank.total).toBe(300);
    expect((await client.getFields({ page: 9_999_999 })).fields).toEqual([]);
    expect(await apiError(client.getFields({ page: 10_000_000 }))).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "page must be an integer from 1 to 9999999.",
    });
    expect(await apiError(client.getFields({ tile: "Bad!" }))).toMatchObject({ status: 400, message: "tile must match ^[a-z][a-z0-9]{0,15}$." });
    expect(await apiError(client.getFields({ verdict: "fraud" as never }))).toMatchObject({
      status: 400,
      message: "verdict must be one of consistent, inconsistent, not_enough_evidence.",
    });
    expect(await apiError(client.getAudit("bad"))).toMatchObject({ status: 400, code: "invalid_request", message: "audit id must match ^a_[0-9a-f]{16}$." });
  });

  it("pages 500 fields at a time, ordered by field_id", async () => {
    const base = nodeFixtureLoader();
    const fields = fixtureJson<FieldCollection>("run/fields.geojson");
    const many = { ...fields, features: [] as FieldCollection["features"][number][] };
    for (let i = 1201; i >= 1; i--) {
      const f = structuredClone(fields.features[i % 300]!);
      f.properties.field_id = `fazilka-${String(10000 + i).padStart(5, "0")}`;
      many.features.push(f);
    }
    const big = fixtureClient(async (name) => (name === "run/fields.geojson" ? many : base(name)));
    const pages = [await big.getFields({ page: 1 }), await big.getFields({ page: 2 }), await big.getFields({ page: 3 })];
    expect(pages.map((p) => p.fields.length)).toEqual([PAGE_SIZE, PAGE_SIZE, 201]);
    expect(pages.map((p) => p.next_page)).toEqual([2, 3, null]);
    expect(pages.every((p) => p.total === 1201 && p.page_size === 500)).toBe(true);
    const ids = pages.flatMap((p) => p.fields.map((f) => f.field_id));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(1201);
    expect(pages[0]!.fields[0]!.awd_verdict).toBeNull(); // no summary for these ids: columns are null
    pages.forEach((p) => expectValid("api/fields_page", p));
  });

  it("getField builds the detail of ANY field from run/ data", async () => {
    assertSameJson(await client.getField("fazilka-00114"), fixtureJson("api/field.fazilka-00114.json"));
    const fields = fixtureJson<FieldCollection>("run/fields.geojson");
    for (const f of fields.features) {
      const detail = await client.getField(f.properties.field_id);
      expectValid("api/field_detail", detail);
      expect(detail.field.properties.field_id).toBe(f.properties.field_id);
      expect(detail.observations).toHaveLength(10);
      const times = detail.observations.map((o) => Date.parse(o.datetime));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(detail.summary).not.toBeNull();
    }
    const missing = await apiError(client.getField("fazilka-99999"));
    expect([missing.status, missing.code, missing.message]).toEqual([
      404,
      "not_found",
      fixtureJson<{ error: { message: string } }>("api/error.not_found.json").error.message,
    ]);
  });

  it("postAudit reproduces the golden response from the exact request bytes; getAudit returns it", async () => {
    const c = fixtureClient();
    const expected = fixtureJson("api/audit.response.json");
    const got = await c.postAudit(fixtureText("api/audit.request.json"));
    assertSameJson(got, expected);
    expectValid("api/audit_response", got);
    assertSameJson(await c.getAudit(got.audit_id), expected);
    // a fresh client still knows the golden audit id
    assertSameJson(await fixtureClient().getAudit(got.audit_id), expected);
  });

  it("postAudit with an object ranks the same and stores the new audit", async () => {
    const c = fixtureClient();
    const req = fixtureJson<AuditRequest>("api/audit.request.json");
    const golden = fixtureJson<{ ranked: unknown; audit_id: string }>("api/audit.response.json");
    const got = await c.postAudit(req);
    assertSameJson(got.ranked, golden.ranked);
    expect(got.audit_id).not.toBe(golden.audit_id); // different bytes, different id (B6 step 8)
    assertSameJson(await c.getAudit(got.audit_id), got);
    const noSeed: AuditRequest = { claims: req.claims, budget: 10 };
    const a = await c.postAudit(noSeed);
    expect(a.seed).toBe(parseInt(a.input_hash.slice(0, 8), 16));
    expect(a.ranked).toHaveLength(10);
  });

  it("postAudit errors carry the API's status and code", async () => {
    const c = fixtureClient();
    expect(await apiError(c.postAudit("{nope"))).toMatchObject({ status: 400, code: "invalid_json" });
    expect(await apiError(c.postAudit("[]"))).toMatchObject({ status: 400, code: "invalid_request" });
    const req = fixtureJson<AuditRequest>("api/audit.request.json");
    const dup = structuredClone(req);
    dup.claims.features[1]!.properties.claim_id = dup.claims.features[0]!.properties.claim_id!;
    expect(await apiError(c.postAudit(dup))).toMatchObject({ status: 400, code: "duplicate_claim_id" });
    const open = structuredClone(req);
    open.claims.features[0]!.geometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    expect(await apiError(c.postAudit(open))).toMatchObject({ status: 400, code: "invalid_geometry" });
    expect(await apiError(c.postAudit({ ...req, budget: 0 }))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await apiError(c.getAudit("a_0000000000000000"))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("returns copies: mutating a result never changes the next one", async () => {
    const c = fixtureClient();
    const story = await c.getStory();
    story.hero_field_id = "zzz-00000";
    expect((await c.getStory()).hero_field_id).toBe(fixtureJson<{ hero_field_id: string }>("api/story.json").hero_field_id);
    const detail = await c.getField("fazilka-00001");
    detail.observations.length = 0;
    expect((await c.getField("fazilka-00001")).observations).toHaveLength(10);
  });

  it("accepts loaders that return raw text, and loads each file once", async () => {
    const seen: string[] = [];
    const raw: FixtureLoader = async (name) => {
      seen.push(name);
      return fixtureText(name);
    };
    const c = fixtureClient(raw);
    assertSameJson(await c.getFields(), fixtureJson("api/fields.json"));
    assertSameJson(await c.getField("fazilka-00114"), fixtureJson("api/field.fazilka-00114.json"));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("a failing loader gives ApiError fixture_unavailable, and a later call retries", async () => {
    let fail = true;
    const base = nodeFixtureLoader();
    const c = fixtureClient(async (name) => {
      if (fail) throw new Error("offline");
      return base(name);
    });
    expect(await apiError(c.getStory())).toMatchObject({ status: 500, code: "fixture_unavailable" });
    fail = false;
    expect((await c.getStory()).run_id).toBe("fixture");
  });

  it("every FIXTURE_FILES entry exists", () => {
    for (const name of FIXTURE_FILES) expect(() => fixtureText(name), name).not.toThrow();
  });
});

describe("fixtures-vite loader (import.meta.glob, run through Vitest's Vite transform)", () => {
  it("serves every fixture file the client reads, parsed exactly like the Node loader", async () => {
    const node = nodeFixtureLoader();
    for (const name of FIXTURE_FILES) assertSameJson(await viteFixtureLoader(name), await node(name), name);
    const c = fixtureClient(viteFixtureLoader);
    assertSameJson(await c.postAudit(fixtureText("api/audit.request.json")), fixtureJson("api/audit.response.json"));
    await expect(viteFixtureLoader("api/nope.json" as never)).rejects.toThrow(/no fixture/);
  });
});

// ------------------------------------------------------------------------------------------------ api mode

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api mode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls each endpoint and returns the parsed body", async () => {
    const { fetch, calls } = mockFetch((url) => json({ url }));
    const c = createClient({ source: "api", baseUrl: "https://mudskipper-nisar.pages.dev/", fetch });
    expect(c.source).toBe("api");
    const B = "https://mudskipper-nisar.pages.dev";
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => c.getHealth(), "/api/health"],
      [() => c.getMeta(), "/api/meta"],
      [() => c.getStory(), "/api/story"],
      [() => c.getPasses(), "/api/passes"],
      [() => c.getStates(), "/api/states"],
      [() => c.getFields(), "/api/fields"],
      [() => c.getFields({ tile: "muktsar", verdict: "consistent", page: 2 }), "/api/fields?tile=muktsar&verdict=consistent&page=2"],
      [() => c.getFields({ page: 3 }), "/api/fields?page=3"],
      [() => c.getField("fazilka-00114"), "/api/fields/fazilka-00114"],
      [() => c.getField("a/b c"), "/api/fields/a%2Fb%20c"],
      [() => c.getDetectability(), "/api/detectability"],
      [() => c.getChecks(), "/api/checks"],
      [() => c.getProvenance(), "/api/provenance"],
      [() => c.getAudit("a_0123456789abcdef"), "/api/audit/a_0123456789abcdef"],
    ];
    for (const [call, path] of cases) expect(await call()).toEqual({ url: B + path });
    expect(calls.every((x) => x.init === undefined || x.init.method === undefined)).toBe(true);
  });

  it("postAudit sends a string body byte for byte and an object as JSON", async () => {
    const { fetch, calls } = mockFetch(() => json(fixtureJson("api/audit.response.json")));
    const c = createClient({ source: "api", fetch });
    const text = readFileSync(new URL("../../contracts/fixtures/api/audit.request.json", import.meta.url), "utf8");
    await c.postAudit(text);
    const req = JSON.parse(text) as AuditRequest;
    await c.postAudit(req);
    expect(calls.map((x) => x.url)).toEqual(["/api/audit", "/api/audit"]);
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: text, headers: { "content-type": "application/json" } });
    expect(calls[1]!.init!.body).toBe(JSON.stringify(req));
  });

  it("non-2xx responses throw ApiError from the contract's error body", async () => {
    const err = fixtureJson<{ error: { code: string; message: string } }>("api/error.not_found.json");
    const c = createClient({ source: "api", fetch: mockFetch(() => json(err, 404)).fetch });
    const e = await apiError(c.getField("fazilka-99999"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(Error);
    expect([e.status, e.code, e.message, e.name]).toEqual([404, "not_found", err.error.message, "ApiError"]);

    const tooBig = createClient({ source: "api", fetch: mockFetch(() => json({ error: { code: "too_large", message: "body > 5 MB" } }, 413)).fetch });
    expect(await apiError(tooBig.postAudit("{}"))).toMatchObject({ status: 413, code: "too_large" });
  });

  it("errors without a contract body, network failures and non-JSON successes", async () => {
    const html = createClient({ source: "api", fetch: mockFetch(() => new Response("<h1>Bad gateway</h1>", { status: 502, statusText: "Bad Gateway" })).fetch });
    expect(await apiError(html.getStory())).toMatchObject({ status: 502, code: "http_502" });
    const down = createClient({
      source: "api",
      fetch: mockFetch(() => {
        throw new TypeError("Failed to fetch");
      }).fetch,
    });
    expect(await apiError(down.getStory())).toMatchObject({ status: 0, code: "network_error" });
    const garbage = createClient({ source: "api", fetch: mockFetch(() => new Response("not json", { status: 200 })).fetch });
    expect(await apiError(garbage.getStory())).toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("a body that fails mid-read is a network_error, not an unhandled rejection", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"v":1,'));
        ctrl.error(new TypeError("connection reset"));
      },
    });
    const c = createClient({ source: "api", fetch: mockFetch(() => new Response(broken, { status: 200 })).fetch });
    expect(await apiError(c.getStory())).toMatchObject({ status: 0, code: "network_error" });
  });

  it("timeoutMs and signal abort a request: ApiError timeout / aborted", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const s = init?.signal;
        s?.addEventListener("abort", () => reject(s.reason));
      });
    const slow = createClient({ source: "api", fetch: hang, timeoutMs: 20 });
    expect(await apiError(slow.getStory())).toMatchObject({ status: 0, code: "timeout" });
    const ctrl = new AbortController();
    const user = createClient({ source: "api", fetch: hang, signal: ctrl.signal });
    const pending = apiError(user.getMeta());
    ctrl.abort();
    expect(await pending).toMatchObject({ status: 0, code: "aborted" });
  });

  it("uses the global fetch by default, looked up at call time", async () => {
    const c = createClient({ source: "api" });
    const { fetch, calls } = mockFetch(() => json(fixtureJson("api/health.json")));
    vi.stubGlobal("fetch", fetch);
    assertSameJson(await c.getHealth(), fixtureJson("api/health.json"));
    expect(calls[0]!.url).toBe("/api/health");
  });

  it("getClaimsSample and getFieldsGeoJson follow meta.assets", async () => {
    const meta = fixtureJson<{ assets: { claims_sample: string; fields_geojson: string } }>("api/meta.json");
    const { fetch, calls } = mockFetch((url) => (url.endsWith("/api/meta") ? json(meta) : json({ got: url })));
    const c = createClient({ source: "api", baseUrl: "https://x.example", fetch });
    expect(await c.getClaimsSample()).toEqual({ got: "https://x.example" + meta.assets.claims_sample });
    expect(await c.getFieldsGeoJson()).toEqual({ got: "https://x.example" + meta.assets.fields_geojson });
    expect(calls.filter((x) => x.url.endsWith("/api/meta"))).toHaveLength(1); // meta fetched once
    const noAssets = createClient({
      source: "api",
      fetch: mockFetch(() => json({ ...meta, assets: { ...meta.assets, claims_sample: null } })).fetch,
    });
    expect(await apiError(noAssets.getClaimsSample())).toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses meta.assets URLs outside /tiles/ instead of fetching another origin (K-344)", async () => {
    const meta = fixtureJson<{ assets: Record<string, string | null> }>("api/meta.json");
    for (const bad of ["//evil.example/x.json", "https://evil.example/x.json", "/tiles/../api/x", "/tiles/runs/%2e%2e/x", "/tiles/a\\b", "/api/meta", "tiles/x", "/tiles/"]) {
      const { fetch, calls } = mockFetch((url) =>
        url.endsWith("/api/meta") ? json({ ...meta, assets: { ...meta.assets, claims_sample: bad, overlays_index: bad } }) : json({}),
      );
      const c = createClient({ source: "api", fetch });
      expect(await apiError(c.getClaimsSample()), bad).toMatchObject({ status: 0, code: "invalid_response" });
      expect(await apiError(c.getOverlaysIndex()), bad).toMatchObject({ status: 0, code: "invalid_response" });
      expect(calls.map((x) => x.url)).toEqual(["/api/meta"]); // nothing but meta was requested
    }
  });
});
