/**
 * StaticRepo: reads the static API bundle (src/bundle-layout.ts) from the Pages ASSETS binding.
 *
 * Every API file is the exact response text, so reads stream the asset body through without parsing it
 * (CPU per request stays near zero whatever the run's size; DECISIONS.md K-313). Only small control data is
 * parsed and kept for the isolate's lifetime (the bundle ships inside the deployment and cannot change while
 * an isolate lives): live.json, the manifest and the decoded ranking input. Pages answers a missing asset
 * with the SPA fallback (index.html, 200), so a response only counts as data if it is not HTML.
 */
import type { DocName, Live } from "../contracts.ts";
import { FIELD_ID } from "../contracts.ts";
import { ApiError } from "../http/errors.ts";
import { LIVE_PATH, docPath, fieldPath, manifestPath, pageKey, pagePath, rankInputPath } from "../bundle-layout.ts";
import { PAGE_SIZE } from "../limits.ts";
import { emptyFieldsPage, type FieldQuery } from "../shapes.ts";
import { FOREVER, IsolateCache } from "./cache.ts";
import { decodeRankInput, type RankInputs } from "./rank-input.ts";
import type { Body, BundleManifest, Repo } from "./types.ts";

const cache = new IsolateCache(16);

/** For tests: forget everything parsed so far. */
export function clearStaticCache(): void {
  cache.clear();
}

/** Fetch an asset; null when it is missing (404 or the SPA fallback page). */
export async function fetchAsset(assets: Fetcher, origin: string, path: string, init?: RequestInit): Promise<Response | null> {
  const res = await assets.fetch(new URL(path, origin).toString(), init);
  if (res.status === 404) return null;
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && type.includes("text/html") && !path.endsWith(".html")) {
    await res.body?.cancel();
    return null;
  }
  return res;
}

export class StaticRepo implements Repo {
  readonly kind = "static" as const;
  private readonly assets: Fetcher;
  private readonly origin: string;

  constructor(assets: Fetcher, origin: string) {
    this.assets = assets;
    this.origin = origin;
  }

  private json<T>(path: string): Promise<T | null> {
    return cache.get(path, FOREVER, async () => {
      const res = await fetchAsset(this.assets, this.origin, path);
      if (res === null) return null;
      if (!res.ok) throw new Error(`asset ${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  /** The asset's body as a stream, or null when it is missing. */
  private async stream(path: string): Promise<Body | null> {
    const res = await fetchAsset(this.assets, this.origin, path);
    if (res === null) return null;
    if (!res.ok || !res.body) throw new Error(`asset ${path}: HTTP ${res.status}`);
    return res.body;
  }

  async live(): Promise<Live> {
    const live = await this.json<Live>(LIVE_PATH);
    if (!live) throw new ApiError(503, "no_live_run", "No run is published yet (missing /data/live.json).");
    return live;
  }

  async manifest(live: Live): Promise<BundleManifest> {
    const m = await this.json<BundleManifest>(manifestPath(live.run_id));
    if (!m) throw new ApiError(503, "no_live_run", `Live run ${live.run_id} is not in this deployment.`);
    return m;
  }

  async version(live: Live): Promise<string> {
    return (await this.manifest(live)).bundle_hash;
  }

  async doc(live: Live, name: DocName): Promise<Body | null> {
    const m = await this.manifest(live);
    if (!m.docs.includes(name)) return null;
    return this.stream(docPath(live.run_id, name));
  }

  async fieldsPage(live: Live, q: FieldQuery): Promise<Body> {
    const m = await this.manifest(live);
    if (!m.pages) throw new ApiError(503, "no_live_run", `Live run ${live.run_id} was bundled without field pages; rebuild it.`);
    const key = pageKey(q.tile, q.verdict);
    const total = Object.hasOwn(m.pages, key) ? m.pages[key]! : 0;
    if ((q.page - 1) * PAGE_SIZE >= total) return JSON.stringify(emptyFieldsPage(live.run_id, live.fixture, total, q));
    const body = await this.stream(pagePath(live.run_id, q.tile, q.verdict, q.page));
    if (body === null) throw new ApiError(503, "storage_unavailable", `Page ${q.page} of ${key} is missing from the deployment.`);
    return body;
  }

  async field(live: Live, fieldId: string): Promise<Body | null> {
    if (!FIELD_ID.test(fieldId)) return null;
    await this.manifest(live);
    // One asset read: a missing shard comes back as the SPA fallback page, which fetchAsset turns into null.
    return this.stream(fieldPath(live.run_id, fieldId));
  }

  rankInputs(live: Live): Promise<RankInputs> {
    return cache.get(`rank:${live.run_id}`, FOREVER, async () => {
      await this.manifest(live);
      const res = await fetchAsset(this.assets, this.origin, rankInputPath(live.run_id));
      if (!res || !res.ok) throw new ApiError(503, "no_live_run", `Run ${live.run_id} has no ranking input (api/rank.bin).`);
      return decodeRankInput(await res.arrayBuffer(), live.run_id);
    });
  }
}
