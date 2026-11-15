// Review item 13: the same calls through core's client in api mode (against this Hono app over the fixture
// bundle) and in fixtures mode give the same results, or the same ApiError (status, code and message).
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApiError, createClient, type MudskipperClient } from "@mudskipper/core/client";
import { nodeFixtureLoader } from "@mudskipper/core/fixtures-node";
import { buildBundle } from "../../scripts/build-bundle.ts";
import { FIXTURE_RUN, REPO_ROOT } from "../../scripts/lib/run.ts";
import { createApp } from "../../src/app.ts";

const site = mkdtempSync(join(tmpdir(), "mudskipper-parity-"));
buildBundle(FIXTURE_RUN, { out: join(site, "data"), fixtureLive: true });
afterAll(() => rmSync(site, { recursive: true, force: true }));

const files = new Map<string, Uint8Array<ArrayBuffer>>();
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.set(p.slice(site.length), new Uint8Array(readFileSync(p)));
  }
};
walk(site);
const TYPES: Record<string, string> = { ".json": "application/json", ".geojson": "application/geo+json", ".png": "image/png" };
const ASSETS = {
  async fetch(input: string | URL | Request) {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    const data = files.get(path);
    return data
      ? new Response(data, { headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream" } })
      : new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
const kv = new Map<string, string>();
const AUDITS = {
  get: async (k: string, type?: string) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)) : null),
  put: async (k: string, v: string) => void kv.set(k, v),
};
const app = createApp({ now: () => new Date("2026-11-14T00:00:00Z") });
const ORIGIN = "https://mudskipper-nisar.pages.dev";
const api = createClient({
  source: "api",
  baseUrl: ORIGIN,
  fetch: (async (url: string | URL | Request, init?: RequestInit) => app.request(String(url), init, { ASSETS, AUDITS } as never)) as typeof fetch,
});
const fixtures = createClient({ source: "fixtures", load: nodeFixtureLoader(join(REPO_ROOT, "contracts", "fixtures")) });

/** A call's outcome as data: the value, or the ApiError's status, code and message. */
async function outcome(fn: (c: MudskipperClient) => Promise<unknown>, c: MudskipperClient): Promise<unknown> {
  try {
    return { ok: await fn(c) };
  } catch (e) {
    if (e instanceof ApiError) return { error: { status: e.status, code: e.code, message: e.message } };
    throw e;
  }
}

const CALLS: [string, (c: MudskipperClient) => Promise<unknown>][] = [
  ["getHealth", (c) => c.getHealth()],
  ["getMeta", (c) => c.getMeta()],
  ["getStory", (c) => c.getStory()],
  ["getPasses", (c) => c.getPasses()],
  ["getStates", (c) => c.getStates()],
  ["getDetectability", (c) => c.getDetectability()],
  ["getChecks", (c) => c.getChecks()],
  ["getProvenance", (c) => c.getProvenance()],
  ["getFields()", (c) => c.getFields()],
  ["getFields tile", (c) => c.getFields({ tile: "muktsar" })],
  ["getFields empty tile = no filter", (c) => c.getFields({ tile: "" })],
  ["getFields verdict", (c) => c.getFields({ verdict: "consistent" })],
  ["getFields tile+verdict", (c) => c.getFields({ tile: "fazilka", verdict: "inconsistent" })],
  ["getFields page 2 (past the end)", (c) => c.getFields({ page: 2 })],
  ["getFields page 9999999", (c) => c.getFields({ page: 9_999_999 })],
  ["getFields page 10000000", (c) => c.getFields({ page: 10_000_000 })],
  ["getFields page 0", (c) => c.getFields({ page: 0 })],
  ["getFields page 1.5", (c) => c.getFields({ page: 1.5 })],
  ["getFields bad tile", (c) => c.getFields({ tile: "Bad!" })],
  ["getFields unknown tile", (c) => c.getFields({ tile: "nowhere" })],
  ["getFields bad verdict", (c) => c.getFields({ verdict: "fraud" as never })],
  ["getField hero", (c) => c.getField("fazilka-00114")],
  ["getField unknown", (c) => c.getField("fazilka-99999")],
  ["getField malformed", (c) => c.getField("BAD")],
  ["getAudit malformed", (c) => c.getAudit("bad")],
  ["getAudit unknown", (c) => c.getAudit("a_0000000000000000")],
  ["getClaimsSample", (c) => c.getClaimsSample()],
  ["getFieldsGeoJson", (c) => c.getFieldsGeoJson()],
  ["getOverlaysIndex", (c) => c.getOverlaysIndex()],
];

describe("core client: api mode (this app) and fixtures mode answer alike", () => {
  it.each(CALLS)("%s", async (_name, fn) => {
    expect(await outcome(fn, api)).toStrictEqual(await outcome(fn, fixtures));
  });

  it("postAudit of the golden bytes, then getAudit of its id", async () => {
    const body = readFileSync(join(REPO_ROOT, "contracts", "fixtures", "api", "audit.request.json"), "utf8");
    const a = await outcome((c) => c.postAudit(body), api);
    const f = await outcome((c) => c.postAudit(body), fixtures);
    expect(a).toStrictEqual(f);
    const id = (a as { ok: { audit_id: string } }).ok.audit_id;
    expect(await outcome((c) => c.getAudit(id), api)).toStrictEqual(await outcome((c) => c.getAudit(id), fixtures));
  });
});
