// /tiles/*: static assets (with and without Range support underneath) and R2, identical semantics.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseRange } from "../../src/http/range.ts";
import { ByteCache, tileCacheControl, tileKey } from "../../src/tiles.ts";
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

describe.each(BACKENDS)("/tiles preconditions and lookups on %s", (name, bindings) => {
  const path = "/tiles/runs/fixture/fields.geojson";

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])("prototype key %s is a 404, not a 500", async (key) => {
    const res = await call(`/tiles/runs/fixture/${key}`, bindings());
    expect(res.status).toBe(404);
    expect(V.error(await res.json())).toBe(true);
  });

  it("If-Match: the current ETag or * proceeds, any other is 412 precondition_failed", async () => {
    const etag = (await call(path, bindings())).headers.get("etag")!;
    expect((await call(path, bindings(), { headers: { "if-match": etag, range: "bytes=0-9" } })).status).toBe(206);
    expect((await call(path, bindings(), { headers: { "if-match": "*" } })).status).toBe(200);
    const res = await call(path, bindings(), { headers: { "if-match": '"someone-else"', range: "bytes=0-9" } });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string } };
    expect(V.error(body)).toBe(true);
    expect(body.error.code).toBe("precondition_failed");
    expect((await call(path, bindings(), { method: "HEAD", headers: { "if-match": '"x"' } })).status).toBe(412);
  });

  it("If-Unmodified-Since: 412 only where the store has a modification date (R2), ignored otherwise", async () => {
    const res = await call(path, bindings(), { headers: { "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT" } });
    expect(res.status).toBe(name === "r2" ? 412 : 200);
    const future = await call(path, bindings(), { headers: { "if-unmodified-since": "Fri, 01 Jan 2100 00:00:00 GMT" } });
    expect(future.status).toBe(200);
    if (name === "r2") expect(future.headers.get("last-modified")).toMatch(/GMT$/);
  });
});

describe("R2 /tiles reads the body only if the object is still the one head() saw", () => {
  it("an object replaced between head() and get() is a 503 to retry, never mixed bytes", async () => {
    let onlyIf: unknown = null;
    const head = { key: "k", size: 10, etag: "e1", httpEtag: '"e1"', uploaded: new Date(0), httpMetadata: { contentType: "application/geo+json" } };
    const racing = {
      head: async () => head,
      get: async (_key: string, opts: { onlyIf?: unknown }) => ((onlyIf = opts.onlyIf), { ...head, etag: "e2" }), // no body: precondition failed
      put: async () => null,
    } as unknown as R2Bucket;
    const res = await call("/tiles/runs/fixture/fields.geojson", envFor("r2", { DATA: racing }));
    expect(onlyIf).toEqual({ etagMatches: "e1" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("storage_unavailable");
  });
});

describe("static /tiles keeps whole files per isolate for ranged reads", () => {
  it("many ranges of one file read the asset once", async () => {
    let reads = 0;
    const counting: Fetcher = {
      fetch: (input: string | Request | URL, init?: RequestInit) => {
        if (String(input instanceof Request ? input.url : input).endsWith("/fields.geojson")) reads++;
        return env.ASSETS.fetch(input, init);
      },
    };
    const b = envFor("static", { ASSETS: counting });
    const want = await fileBytes("fields.geojson");
    for (let i = 0; i < 12; i++) {
      const start = i * 97;
      const res = await call("/tiles/runs/fixture/fields.geojson", b, { headers: { range: `bytes=${start}-${start + 99}` } });
      expect(res.status).toBe(206);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(want.subarray(start, start + 100));
    }
    expect(reads).toBe(1);
  });

  it("ByteCache evicts least recently used files to stay inside its budget", async () => {
    const cache = new ByteCache(10);
    const load = (n: number) => async () => new ArrayBuffer(n);
    await cache.get("a", 4, load(4));
    await cache.get("b", 4, load(4));
    await cache.get("a", 4, load(4)); // a is now the most recent
    let loaded = false;
    await cache.get("c", 4, async () => ((loaded = true), new ArrayBuffer(4)));
    expect(loaded).toBe(true);
    expect(cache.bytesUsed).toBe(8); // b was evicted
    let again = false;
    await cache.get("a", 4, async () => ((again = true), new ArrayBuffer(4)));
    expect(again).toBe(false);
  });
});
