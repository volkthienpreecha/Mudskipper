// POST /api/audit and GET /api/audit/:id: limits, validation order, hashing, ids, storage on KV and D1.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../../src/limits.ts";
import { auditId, defaultSeed, sha256Hex } from "../../src/crypto.ts";
import { RankError, type RankFn } from "../../src/audit/rank.ts";
import { call, envFor, fixtureApi, goldenRank, resetCaches, validators as V, type BackendKind } from "./helpers.ts";

beforeEach(resetCaches);

const golden = () => JSON.parse(env.TEST_AUDIT_REQUEST) as { claims: { features: Record<string, unknown>[] }; budget: number; seed?: number };
const post = (body: BodyInit, kind: BackendKind | ReturnType<typeof envFor> = "static", rank?: RankFn, headers: Record<string, string> = {}) =>
  call("/api/audit", kind, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }, rank);

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string } };
  expect(V.error(body)).toBe(true);
  expect(body.error.code).toBe(code);
}

describe("POST /api/audit: limits and validation (B6 error codes)", () => {
  it("413 too_large from Content-Length before reading", async () => {
    const res = await post("{}", "static", undefined, { "content-length": String(MAX_BODY_BYTES + 1) });
    await expectError(res, 413, "too_large");
  });

  it("413 too_large while streaming a body with no Content-Length", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ < 6) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    await expectError(await post(stream, "static"), 413, "too_large");
  });

  it("accepts a body of exactly 5 MB (limit is inclusive) and moves on to validation", async () => {
    const body = JSON.stringify({ x: "a".repeat(MAX_BODY_BYTES - 8) });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY_BYTES);
    await expectError(await post(body), 400, "invalid_request");
  });

  it("400 invalid_json for bad JSON and for bytes that are not UTF-8", async () => {
    await expectError(await post("{not json"), 400, "invalid_json");
    await expectError(await post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 400, "invalid_json");
    await expectError(await post(""), 400, "invalid_json");
  });

  it("400 too_many_claims above 5,000 claims", async () => {
    const req = golden();
    const one = req.claims.features[0]!;
    req.claims.features = Array.from({ length: 5001 }, (_, i) => ({ ...one, properties: { claimed: ["awd"], synthetic: true, claim_id: `c${i}` } }));
    await expectError(await post(JSON.stringify(req)), 400, "too_many_claims");
  });

  it.each([
    ["missing budget", (r: ReturnType<typeof golden>) => { delete (r as Partial<typeof r>).budget; }],
    ["budget 0", (r: ReturnType<typeof golden>) => { r.budget = 0; }],
    ["budget 501", (r: ReturnType<typeof golden>) => { r.budget = 501; }],
    ["negative seed", (r: ReturnType<typeof golden>) => { r.seed = -1; }],
    ["extra member", (r: ReturnType<typeof golden>) => { (r as Record<string, unknown>)["user"] = "x"; }],
    ["no claims", (r: ReturnType<typeof golden>) => { r.claims.features = []; }],
    ["bad practice", (r: ReturnType<typeof golden>) => { (r.claims.features[0]!["properties"] as Record<string, unknown>)["claimed"] = ["swd"]; }],
    ["line geometry", (r: ReturnType<typeof golden>) => { r.claims.features[0]!["geometry"] = { type: "LineString", coordinates: [[74, 30], [74.1, 30.1]] }; }],
  ])("400 invalid_request: %s", async (_name, mutate) => {
    const req = golden();
    mutate(req);
    await expectError(await post(JSON.stringify(req)), 400, "invalid_request");
  });

  it("400 invalid_geometry for an open ring", async () => {
    const req = golden();
    req.claims.features[0]!["geometry"] = { type: "Polygon", coordinates: [[[74, 30], [74.1, 30], [74.1, 30.1], [74, 30.1]]] };
    await expectError(await post(JSON.stringify(req)), 400, "invalid_geometry");
  });

  it("400 duplicate_claim_id", async () => {
    const req = golden();
    (req.claims.features[1]!["properties"] as Record<string, unknown>)["claim_id"] = (req.claims.features[0]!["properties"] as Record<string, string>)["claim_id"];
    await expectError(await post(JSON.stringify(req)), 400, "duplicate_claim_id");
  });

  it("claims without claim_id get #n ids, which can never collide with a valid claim_id", async () => {
    const req = golden();
    for (const f of req.claims.features) delete (f["properties"] as Record<string, unknown>)["claim_id"];
    await expectError(await post(JSON.stringify(req)), 501, "not_implemented");
  });

  it("accepts ordinary GIS exports: extra members, extra properties, altitude", async () => {
    const req = golden();
    (req.claims as Record<string, unknown>)["name"] = "export";
    (req.claims as Record<string, unknown>)["crs"] = { type: "name", properties: { name: "EPSG:4326" } };
    (req.claims.features[0]!["properties"] as Record<string, unknown>)["notes"] = "x";
    req.claims.features[0]!["geometry"] = { type: "Point", coordinates: [74.1, 30.3, 182.5] };
    await expectError(await post(JSON.stringify(req)), 501, "not_implemented");
  });
});

describe("POST /api/audit: Phase 1 ranking seam", () => {
  it("a valid request reaches the ranking and gets 501 not_implemented until core lands", async () => {
    await expectError(await post(env.TEST_AUDIT_REQUEST), 501, "not_implemented");
  });

  it("503 storage_unavailable when neither D1 nor KV is bound", async () => {
    await expectError(await post(env.TEST_AUDIT_REQUEST, { ASSETS: env.ASSETS }, goldenRank), 503, "storage_unavailable");
  });

  it("maps a RankError from core to 400 with its code", async () => {
    const failing: RankFn = async () => {
      throw new RankError("invalid_geometry", "claim SYN-0001: no interior point");
    };
    await expectError(await post(env.TEST_AUDIT_REQUEST, "static", failing), 400, "invalid_geometry");
  });

  it("hides unexpected ranking failures behind a 500 internal error", async () => {
    const boom: RankFn = async () => {
      throw new Error("secret detail");
    };
    const res = await post(env.TEST_AUDIT_REQUEST, "static", boom);
    await expectError(res.clone(), 500, "internal");
    expect(await res.text()).not.toContain("secret detail");
  });
});

describe.each(["static", "d1"] as BackendKind[])("audit storage round trip (%s backend)", (kind) => {
  it("input_hash, seed and audit_id follow CONTRACTS.md B6 step 8 (golden request)", async () => {
    const bytes = env.TEST_AUDIT_REQUEST;
    const hash = await sha256Hex(bytes);
    const want = fixtureApi("audit.response");
    expect(hash).toBe(want["input_hash"]);
    expect(await auditId("fixture", hash, 20, 7)).toBe(want["audit_id"]);
    expect(defaultSeed("0000000a" + "0".repeat(56))).toBe(10);
  });

  it("POST stores (201 + Location), repeats return the stored copy (200), GET serves it immutable", async () => {
    const want = fixtureApi("audit.response");
    const first = await post(env.TEST_AUDIT_REQUEST, kind, goldenRank);
    expect(first.status).toBe(201);
    const id = want["audit_id"] as string;
    expect(first.headers.get("location")).toBe(`/api/audit/${id}`);
    const body = await first.json();
    expect(V.auditResponse(body)).toBe(true);
    expect(body).toStrictEqual({ ...want, created_at: "2026-11-14T00:00:00Z" });

    const again = await post(env.TEST_AUDIT_REQUEST, kind, async () => {
      throw new Error("must not re-rank a stored audit");
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toStrictEqual(body);

    const got = await call(`/api/audit/${id}`, kind);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await got.json()).toStrictEqual(body);
  });

  it("stores in D1 `audits` when DB is bound, otherwise in KV", async () => {
    const want = fixtureApi("audit.response");
    await post(env.TEST_AUDIT_REQUEST, kind, goldenRank);
    const id = want["audit_id"] as string;
    const inD1 = await env.DB.prepare("SELECT audit_id, budget, seed, synthetic FROM audits WHERE audit_id = ?").bind(id).first();
    const inKv = await env.AUDITS.get(`audit:${id}`);
    if (kind === "d1") expect(inD1).toMatchObject({ audit_id: id, budget: 20, seed: 7, synthetic: 1 });
    else expect(inKv).not.toBeNull();
  });

  it("GET /api/audit/:id is 404 when missing and 400 when malformed", async () => {
    await expectError(await call("/api/audit/a_ffffffffffffffff", kind), 404, "not_found");
    await expectError(await call("/api/audit/not-an-id", kind), 400, "invalid_request");
  });

  it("a different seed is a different audit", async () => {
    const req = golden();
    req.seed = 8;
    const body = JSON.stringify(req, null, 2) + "\n";
    const res = await post(body, kind, goldenRank);
    expect(res.status).toBe(201);
    const id = await auditId("fixture", await sha256Hex(body), 20, 8);
    expect(id).not.toBe(fixtureApi("audit.response")["audit_id"]);
    expect(res.headers.get("location")).toBe(`/api/audit/${id}`);
    expect(((await res.json()) as { audit_id: string }).audit_id).toBe(id);
  });
});

// TODO(core): enable when @mudskipper/core is wired into src/audit/rank.ts (Phase 2).
describe.skip("POST /api/audit with core's ranking (Phase 2)", () => {
  it("the golden request ranks exactly as contracts/fixtures/api/audit.response.json", async () => {
    const res = await post(env.TEST_AUDIT_REQUEST, "static");
    expect(res.status).toBe(201);
    expect(await res.json()).toStrictEqual({ ...fixtureApi("audit.response"), created_at: "2026-11-14T00:00:00Z" });
  });
  it("exactly 20% random picks and the same output for the same seed (T7)", async () => {
    const a = (await (await post(env.TEST_AUDIT_REQUEST, "d1")).json()) as { ranked: { pick: string }[] };
    expect(a.ranked.filter((r) => r.pick === "random")).toHaveLength(Math.floor((20 + 2) / 5));
  });
});
