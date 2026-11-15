/**
 * One read interface over both storage backends (DECISIONS.md K-003). Routes depend only on this, so the
 * static bundle and D1 give the same responses, and tests run every route against both.
 */
import type { Doc, DocName, FieldDetail, FieldFeature, FieldRow, FieldSummary, Live } from "../contracts.ts";

export interface RankInputs {
  fields: FieldFeature[];
  summaries: Map<string, FieldSummary>;
}

export interface Repo {
  readonly kind: "static" | "d1";
  /** The run being served (live.json). Throws ApiError 503 `no_live_run` if nothing is published. */
  live(): Promise<Live>;
  /** A content version of the live run's data, for ETags (changes whenever any response could change). */
  version(live: Live): Promise<string>;
  /** A whole run-level response (meta, story, …), or null if the run has no such document (e.g. no checks yet). */
  doc(live: Live, name: DocName): Promise<Doc | null>;
  /** Every field row of the run, ordered by field_id. */
  fieldRows(live: Live): Promise<FieldRow[]>;
  /** GET /api/fields/:id, or null if the run has no such field. */
  field(live: Live, fieldId: string): Promise<FieldDetail | null>;
  /** What ranking needs: polygons and season summaries. */
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
  /** Raw run files served under /tiles/runs/<run_id>/<path>. */
  files: Record<string, TileFile>;
}

export interface TileFile {
  size: number;
  sha256: string;
  type: string;
}
