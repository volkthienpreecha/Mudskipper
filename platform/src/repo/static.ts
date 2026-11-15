/**
 * StaticRepo: reads the static API bundle (src/bundle-layout.ts) from the Pages ASSETS binding.
 *
 * The bundle ships inside the deployment, so it cannot change while an isolate is alive: everything parsed is
 * cached for the isolate's lifetime. Pages answers a missing asset with the SPA fallback (index.html, 200),
 * so a response only counts as data if it is JSON; the manifest is consulted first so missing documents and
 * fields are 404s without a round trip.
 */
import type { Doc, DocName, FieldDetail, FieldFeature, FieldRow, FieldSummary, Live } from "../contracts.ts";
import { FIELD_ID } from "../contracts.ts";
import { ApiError } from "../http/errors.ts";
import { LIVE_PATH, docPath, fieldPath, fieldRowsPath, manifestPath, summariesPath, tilePath } from "../bundle-layout.ts";
import { FOREVER, IsolateCache } from "./cache.ts";
import type { BundleManifest, RankInputs, Repo } from "./types.ts";

const cache = new IsolateCache(256);

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

  async doc(live: Live, name: DocName): Promise<Doc | null> {
    const m = await this.manifest(live);
    if (!m.docs.includes(name)) return null;
    return this.json<Doc>(docPath(live.run_id, name));
  }

  async fieldRows(live: Live): Promise<FieldRow[]> {
    await this.manifest(live);
    const doc = await this.json<{ rows: FieldRow[] }>(fieldRowsPath(live.run_id));
    return doc?.rows ?? [];
  }

  async field(live: Live, fieldId: string): Promise<FieldDetail | null> {
    if (!FIELD_ID.test(fieldId)) return null;
    const rows = await this.fieldRows(live);
    if (!rows.some((r) => r.field_id === fieldId)) return null;
    // Shards are not cached: 5,000 of them would crowd out the shared documents.
    const res = await fetchAsset(this.assets, this.origin, fieldPath(live.run_id, fieldId));
    if (res === null) return null;
    return (await res.json()) as FieldDetail;
  }

  async rankInputs(live: Live): Promise<RankInputs> {
    const m = await this.manifest(live);
    if (!m.files["fields.geojson"]) throw new ApiError(503, "no_live_run", `Run ${live.run_id} has no fields.geojson.`);
    const [fc, summaries] = await Promise.all([
      this.json<{ features: FieldFeature[] }>(tilePath(live.run_id, "fields.geojson")),
      this.json<FieldSummary[]>(summariesPath(live.run_id)),
    ]);
    return {
      fields: fc?.features ?? [],
      summaries: new Map((summaries ?? []).map((s) => [s.field_id, s])),
    };
  }
}
