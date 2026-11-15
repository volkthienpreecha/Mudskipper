/**
 * GET /tiles/<key> (CONTRACTS.md B5/B6): run files for the map (fields.geojson, fields.pmtiles, overlays,
 * histograms, sample claims) with byte ranges, so PMTiles can read a 16 KiB header and then single tiles.
 *
 * - R2 (DATA bound): `<key>` in bucket mudskipper-data (live.json, runs/<run_id>/…, basemap/…).
 * - Static (today): `<key>` = `runs/<run_id>/<path>` in the deployment under /data/. Only files the run's
 *   manifest lists are served (so the SPA fallback page is never mistaken for a tile), with a strong ETag from
 *   the file's sha256 and exact Range/206/416/304 semantics (src/http/range.ts).
 */
import { contentTypeOf, manifestPath, tilePath } from "./bundle-layout.ts";
import { RUN_ID } from "./contracts.ts";
import type { Bindings } from "./env.ts";
import { ApiError, notFound } from "./http/errors.ts";
import { CACHE } from "./http/headers.ts";
import { serveRepresentation } from "./http/range.ts";
import { FOREVER, IsolateCache } from "./repo/cache.ts";
import { fetchAsset } from "./repo/static.ts";
import type { BundleManifest } from "./repo/types.ts";

const manifests = new IsolateCache(16);

export function clearTilesCache(): void {
  manifests.clear();
}

/** Cache policy by key: a real run's files never change; the fixture run is regenerated in place. */
export function tileCacheControl(key: string): string {
  const m = /^runs\/([^/]+)\//.exec(key);
  if (!m) return key === "live.json" ? CACHE.none : "public, max-age=86400";
  return m[1] === "fixture" ? CACHE.fixtureRun : CACHE.run;
}

/** Decode and sanity-check the key after /tiles/. Returns null for anything that could escape the prefix. */
export function tileKey(pathname: string): string | null {
  const raw = pathname.replace(/^\/tiles\/?/, "");
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (key === "" || key.startsWith("/") || key.includes("\\") || key.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }
  return key;
}

export async function serveTile(req: Request, env: Bindings, backend: "r2" | "static"): Promise<Response> {
  const key = tileKey(new URL(req.url).pathname);
  if (key === null) throw notFound("No such tile key.");
  return backend === "r2" && env.DATA ? serveR2(req, env.DATA, key) : serveStatic(req, env.ASSETS, key);
}

async function serveStatic(req: Request, assets: Fetcher, key: string): Promise<Response> {
  const m = /^runs\/([^/]+)\/(.+)$/.exec(key);
  if (!m || !RUN_ID.test(m[1]!)) throw notFound(`No tile ${key}.`);
  const runId = m[1]!;
  const rel = m[2]!;
  const origin = new URL(req.url).origin;
  const manifest = await manifests.get<BundleManifest | null>(runId, FOREVER, async () => {
    const res = await fetchAsset(assets, origin, manifestPath(runId));
    return res ? ((await res.json()) as BundleManifest) : null;
  });
  const file = manifest?.files[rel];
  if (!manifest || !file) throw notFound(`No tile ${key}.`);
  const assetUrl = tilePath(runId, rel);

  return serveRepresentation(req, {
    size: file.size,
    etag: `"${file.sha256.slice(0, 32)}"`,
    contentType: file.type || contentTypeOf(rel),
    cacheControl: tileCacheControl(key),
    async body(range) {
      const init: RequestInit = range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {};
      const res = await fetchAsset(assets, origin, assetUrl, init);
      if (!res || !res.ok) throw new ApiError(502, "internal", `Static asset ${assetUrl} is missing from the deployment.`);
      if (!range) return res.body;
      // Pages may or may not honour Range on asset fetches; slice the full body ourselves when it does not.
      if (res.status === 206 && res.headers.get("content-range") === `bytes ${range.start}-${range.end}/${file.size}`) {
        return res.body;
      }
      const buf = await res.arrayBuffer();
      return buf.slice(range.start, range.end + 1);
    },
  });
}

/**
 * R2 proxy. Derived from the tested handler in the research notes, with one change: the object's size comes
 * from `head()` first and the range is computed by src/http/range.ts, so R2 and static answer every Range,
 * If-None-Match and If-Range case identically (including 416 with the size, which `get()` alone cannot give).
 */
async function serveR2(req: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const head = await bucket.head(key);
  if (!head) throw notFound(`No tile ${key}.`);
  return serveRepresentation(req, {
    size: head.size,
    etag: head.httpEtag,
    contentType: head.httpMetadata?.contentType ?? contentTypeOf(key),
    cacheControl: tileCacheControl(key),
    async body(range) {
      const obj = await bucket.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
      if (!obj) throw notFound(`No tile ${key}.`);
      return obj.body;
    },
  });
}
