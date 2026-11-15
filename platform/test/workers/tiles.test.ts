// /tiles/*: static assets (with and without Range support underneath) and R2, identical semantics.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseRange } from "../../src/http/range.ts";
import { tileCacheControl, tileKey } from "../../src/tiles.ts";
import type { BundleManifest } from "../../src/repo/types.ts";
import { call, envFor, resetCaches, validators as V } from "./helpers.ts";
import type { Bindings } from "../../src/env.ts";

beforeEach(resetCaches);

describe("parseRange (RFC 9110 §14.1.2)", () => {
  it.each([
    ["bytes=0-99", 1000, { kind: "range", range: { start: 0, end: 99 } }],
    ["bytes=900-", 1000, { kind: "range", range: { start: 900, end: 999 } }],
    ["bytes=-100", 1000, { kind: "range", range: { start: 900, end: 999 } }],
    ["bytes=-5000", 1000, { kind: "range", range: { start: 0, end: 999 } }],
    ["bytes=990-5000", 1000, { kind: "range", range: { start: 990, end: 999 } }],
    ["bytes=999-999", 1000, { kind: "range", range: { start: 999, end: 999 } }],
    ["bytes=1000-", 1000, { kind: "unsatisfiable" }],
    ["bytes=-0", 1000, { kind: "unsatisfiable" }],
    ["bytes=0-", 0, { kind: "unsatisfiable" }],
    ["bytes=5-2", 1000, { kind: "none" }],
    ["bytes=0-1,5-6", 1000, { kind: "none" }],
    ["items=0-1", 1000, { kind: "none" }],
    ["bytes=-", 1000, { kind: "none" }],
    ["garbage", 1000, { kind: "none" }],
  ])("%s of %i bytes", (header, size, want) => {
    expect(parseRange(header, size)).toEqual(want);
  });

  it("tile keys cannot escape the prefix", () => {
    expect(tileKey("/tiles/runs/fixture/fields.geojson")).toBe("runs/fixture/fields.geojson");
    for (const bad of ["/tiles/", "/tiles/runs//x", "/tiles/runs/../live.json", "/tiles/runs/%2e%2e/x", "/tiles/%E0%A4%A"]) {
      expect(tileKey(bad)).toBeNull();
    }
  });

  it("cache policy: real runs immutable, fixture run short, live.json never", () => {
    expect(tileCacheControl("runs/r01/fields.pmtiles")).toBe("public, max-age=31536000, immutable");
    expect(tileCacheControl("runs/fixture/fields.geojson")).toBe("public, max-age=300, stale-while-revalidate=86400");
    expect(tileCacheControl("live.json")).toBe("no-store");
  });
});

async function fileBytes(rel: string): Promise<Uint8Array> {
  const res = await env.ASSETS.fetch(`https://x/data/runs/fixture/${rel}`);
  return new Uint8Array(await res.arrayBuffer());
}

const BACKENDS: [string, () => Bindings][] = [
  ["static (assets without Range)", () => envFor("static")],
  ["static (assets with Range)", () => envFor("static", { ASSETS: env.ASSETS_RANGE })],
  ["r2", () => envFor("r2")],
];

describe.each(BACKENDS)("/tiles on %s", (_name, bindings) => {
  const path = "/tiles/runs/fixture/fields.geojson";

  it("200 with the whole file, type, length, ETag and Accept-Ranges", async () => {
    const want = await fileBytes("fields.geojson");
    const res = await call(path, bindings());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/geo+json");
    expect(res.headers.get("content-length")).toBe(String(want.byteLength));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(want);
  });

  it.each([
    ["bytes=0-16383", (n: number) => [0, Math.min(16383, n - 1)]],
    ["bytes=100-199", () => [100, 199]],
    ["bytes=1000-", (n: number) => [1000, n - 1]],
    ["bytes=-512", (n: number) => [n - 512, n - 1]],
  ])("206 for %s", async (range, expected) => {
    const want = await fileBytes("fields.geojson");
    const [start, end] = expected(want.byteLength) as [number, number];
    const res = await call(path, bindings(), { headers: { range } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${want.byteLength}`);
    expect(res.headers.get("content-length")).toBe(String(end - start + 1));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(want.subarray(start, end + 1));
  });

  it("416 with Content-Range */size for an unsatisfiable range", async () => {
    const size = (await fileBytes("fields.geojson")).byteLength;
    const res = await call(path, bindings(), { headers: { range: `bytes=${size}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    const body = (await res.json()) as { error: { code: string } };
    expect(V.error(body)).toBe(true);
    expect(body.error.code).toBe("range_not_satisfiable");
  });

  it("304 for a matching If-None-Match, even with a Range", async () => {
    const etag = (await call(path, bindings())).headers.get("etag")!;
    const res = await call(path, bindings(), { headers: { "if-none-match": etag, range: "bytes=0-9" } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
  });

  it("If-Range with a stale ETag ignores the Range (200, whole file)", async () => {
    const res = await call(path, bindings(), { headers: { "if-range": '"stale"', range: "bytes=0-9" } });
    expect(res.status).toBe(200);
  });

  it("If-Range with the current ETag honours the Range", async () => {
    const etag = (await call(path, bindings())).headers.get("etag")!;
    const res = await call(path, bindings(), { headers: { "if-range": etag, range: "bytes=0-9" } });
    expect(res.status).toBe(206);
  });

  it("multi-range requests get the whole file", async () => {
    const res = await call(path, bindings(), { headers: { range: "bytes=0-1,4-5" } });
    expect(res.status).toBe(200);
  });

  it("HEAD has headers and no body", async () => {
    const res = await call(path, bindings(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("serves every file in the manifest byte for byte (PNG overlays and histograms too)", async () => {
    const manifest = (await (await env.ASSETS.fetch("https://x/data/runs/fixture/manifest.json")).json()) as BundleManifest;
    expect(Object.keys(manifest.files).sort()).toEqual([
      "claims.sample.geojson",
      "fields.geojson",
      "hist/early.png",
      "hist/late.png",
      "hist/mid.png",
      "overlays/20260623-T135D_fazilka.png",
      "overlays/20260810-T135D_fazilka.png",
      "overlays/20260915-T135D_fazilka.png",
      "overlays/index.json",
    ]);
    for (const [rel, f] of Object.entries(manifest.files)) {
      const res = await call(`/tiles/runs/fixture/${rel}`, bindings());
      expect(res.status, rel).toBe(200);
      expect(res.headers.get("content-type")).toBe(f.type);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(await fileBytes(rel));
    }
  });

  it.each([
    "/tiles/runs/fixture/nope.png",
    "/tiles/runs/fixture/api/meta.json",
    "/tiles/runs/other/fields.geojson",
    "/tiles/runs/fixture/observations.jsonl",
    "/tiles/basemap/punjab.pmtiles",
  ])("404 JSON for %s", async (p) => {
    const res = await call(p, bindings());
    expect(res.status).toBe(404);
    expect(V.error(await res.json())).toBe(true);
  });
});
