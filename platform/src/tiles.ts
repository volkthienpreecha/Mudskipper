/**
 * GET /tiles/<key> (CONTRACTS.md B5/B6): run files for the map (fields.geojson, fields.pmtiles, overlays,
 * histograms, sample claims) with byte ranges, so PMTiles can read a 16 KiB header and then single tiles.
 *
 * - R2 (DATA bound): `<key>` in bucket mudskipper-data (live.json, runs/<run_id>/…, basemap/…).
 * - Static (today): `<key>` = `runs/<run_id>/<path>` in the deployment under /data/. Only files the run's
 *   manifest lists are served (so the SPA fallback page is never mistaken for a tile), with a strong ETag from
 *   the file's sha256 and exact Range/206/416/304/412 semantics (src/http/range.ts).
 *
 * Pages static assets ignore Range (K-303), so a ranged read needs the whole file. Files up to
 * TILE_CACHE_FILE_BYTES are read once per isolate and kept (keyed by sha256, LRU within TILE_CACHE_BYTES),
 * so the many small ranges a PMTiles client sends cost a slice, not a 3 MB copy each (DECISIONS.md K-314).
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

/** Per-isolate byte budget for whole tile files (isolates have 128 MB). */
export const TILE_CACHE_BYTES = 24 * 1024 * 1024;
/** Larger files are never cached; their ranges read the asset each time. */
export const TILE_CACHE_FILE_BYTES = 8 * 1024 * 1024;

/** LRU of whole files by sha256, within a byte budget. Entries are promises, so concurrent reads share one fetch. */
export class ByteCache {
  private readonly entries = new Map<string, { bytes: Promise<ArrayBuffer>; size: number }>();
  private used = 0;
  private readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  get(key: string, size: number, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); // re-insert: most recently used last
      this.entries.set(key, hit);
      return hit.bytes;
    }
    while (this.used + size > this.budget && this.entries.size > 0) {
      const [oldest, e] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.used -= e.size;
    }
    const bytes = load();
    const entry = { bytes, size };
    this.entries.set(key, entry);
    this.used += size;
    bytes.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.used -= size;
      }
    });
    return bytes;
  }

  get bytesUsed(): number {
    return this.used;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}

const tileBytes = new ByteCache(TILE_CACHE_BYTES);

export function clearTilesCache(): void {
  manifests.clear();
  tileBytes.clear();
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
  // Object.hasOwn: a key like `__proto__` or `constructor` must not reach Object.prototype (404, not 500).
  const file = manifest && Object.hasOwn(manifest.files, rel) ? manifest.files[rel] : undefined;
  if (!manifest || !file) throw notFound(`No tile ${key}.`);
  const assetUrl = tilePath(runId, rel);
  const whole = async (): Promise<ArrayBuffer> => {
    const res = await fetchAsset(assets, origin, assetUrl);
    if (!res || !res.ok) throw new ApiError(502, "internal", `Static asset ${assetUrl} is missing from the deployment.`);
    return res.arrayBuffer();
  };

  return serveRepresentation(req, {
    size: file.size,
    etag: `"${file.sha256.slice(0, 32)}"`,
    contentType: file.type || contentTypeOf(rel),
    cacheControl: tileCacheControl(key),
    async body(range) {
      if (!range) {
        const res = await fetchAsset(assets, origin, assetUrl);
        if (!res || !res.ok) throw new ApiError(502, "internal", `Static asset ${assetUrl} is missing from the deployment.`);
        return res.body;
      }
      const buf = file.size <= TILE_CACHE_FILE_BYTES ? await tileBytes.get(file.sha256, file.size, whole) : await whole();
      return buf.slice(range.start, range.end + 1);
    },
  });
}

/**
 * R2 proxy. The object's size comes from `head()` first and the range is computed by src/http/range.ts, so R2
 * and static answer every Range and conditional case identically (including 416 with the size, which `get()`
 * alone cannot give). The body is read with `onlyIf: { etagMatches }`, so an object replaced between the two
 * calls is a 503 to retry, never bytes of one version under the headers of another.
 */
async function serveR2(req: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const head = await bucket.head(key);
  if (!head) throw notFound(`No tile ${key}.`);
  return serveRepresentation(req, {
    size: head.size,
    etag: head.httpEtag,
    lastModified: head.uploaded,
    contentType: head.httpMetadata?.contentType ?? contentTypeOf(key),
    cacheControl: tileCacheControl(key),
    async body(range) {
      const obj = await bucket.get(key, {
        onlyIf: { etagMatches: head.etag },
        ...(range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {}),
      });
      if (!obj) throw notFound(`No tile ${key}.`);
      if (!("body" in obj)) throw new ApiError(503, "storage_unavailable", `Tile ${key} changed while it was read; retry.`);
      return obj.body;
    },
  });
}
