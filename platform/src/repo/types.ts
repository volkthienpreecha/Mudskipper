/**
 * One read interface over both storage backends (DECISIONS.md K-003). Routes depend only on this, so the
 * static bundle and D1 give the same responses, and tests run every route against both.
 *
 * Read methods return the response body as the exact JSON text the API sends (`Body`): the static backend
 * streams a pre-serialized file without parsing it, D1 returns stored or freshly serialized text. Bodies are
 * JSON.stringify output of the same builders (src/shapes.ts), so both backends agree by parsed value.
 */
import type { DocName, Live } from "../contracts.ts";
import type { FieldQuery } from "../shapes.ts";
import type { RankInputs } from "./rank-input.ts";

export type { RankInputs };

/** A JSON response body: text, or a byte stream of UTF-8 JSON. */
export type Body = string | ReadableStream<Uint8Array>;

export interface Repo {
  readonly kind: "static" | "d1";
  /** The run being served (live.json). Throws ApiError 503 `no_live_run` if nothing is published. */
  live(): Promise<Live>;
  /**
   * The live run's content version (its bundle_hash), for ETags and audit storage. Throws ApiError 503
   * `no_live_run` when the run's data is missing, so /api/health cannot say ok for a broken deployment.
   */
  version(live: Live): Promise<string>;
  /** A whole run-level response (meta, story, …), or null if the run has no such document (e.g. no checks yet). */
  doc(live: Live, name: DocName): Promise<Body | null>;
  /** GET /api/fields for an already validated query (past the last page: an empty page). */
  fieldsPage(live: Live, q: FieldQuery): Promise<Body>;
  /** GET /api/fields/:id, or null if the run has no such field. */
  field(live: Live, fieldId: string): Promise<Body | null>;
  /** What ranking needs: a spatial index of the polygons, and the season summaries. */
  rankInputs(live: Live): Promise<RankInputs>;
}

/** Written by scripts/build-bundle.ts to /data/runs/<run_id>/manifest.json and by the D1 loader to `docs`. */
export interface BundleManifest {
  v: 1;
  run_id: string;
  fixture: boolean;
  /** sha256 over every bundle file (path + content), hex. */
  bundle_hash: string;
  /** Run-level API documents present in the bundle. */
  docs: DocName[];
  /** Number of fields (one detail shard each). */
  fields: number;
  /**
   * GET /api/fields totals by filter (`pageKey(tile, verdict)`), for every filter that matches at least one
   * field; pages 1 … ceil(total / 500) of each are files under api/pages/. Absent: the filter matches nothing.
   */
  pages?: Record<string, number>;
  /** Raw run files served under /tiles/runs/<run_id>/<path>. */
  files: Record<string, TileFile>;
}

export interface TileFile {
  size: number;
  sha256: string;
  type: string;
}
