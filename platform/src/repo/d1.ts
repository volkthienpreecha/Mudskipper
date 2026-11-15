/**
 * D1Repo: serves the API from the SPEC B4 tables (migrations/0001_init.sql).
 *
 * Live run: R2 `live.json` when DATA is bound (SPEC B5; publish writes it last), else the D1 copy in
 * `meta` under key "live". Reads are cheap on D1 but not free (5M rows read per day on the free plan), so the
 * whole-run field list is read once per isolate and filtered in memory, exactly like the static backend.
 */
import { fieldIndex } from "@mudskipper/core";
import type { DocName, FieldRow, FieldSummary, Live } from "../contracts.ts";
import { FIELD_ID } from "../contracts.ts";
import { ApiError } from "../http/errors.ts";
import { fieldDetail, fieldRow, fieldsPage, orderedObservationRows, type FieldQuery } from "../shapes.ts";
import { FIELDS, OBSERVATIONS, SUMMARIES, rowToField, rowToObservation, rowToSummary, type Row } from "../d1/tables.ts";
import { IsolateCache } from "./cache.ts";
import type { Body, BundleManifest, RankInputs, Repo } from "./types.ts";

const cache = new IsolateCache(64);
/** How long an isolate trusts its copy of live.json; a flip is visible within this window. */
export const LIVE_TTL_MS = 15_000;
/** How long an isolate keeps run data (a re-load of the same run_id shows up within this window). */
export const DATA_TTL_MS = 60_000;

export function clearD1Cache(): void {
  cache.clear();
}

export class D1Repo implements Repo {
  readonly kind = "d1" as const;
  private readonly db: D1Database;
  private readonly data: R2Bucket | undefined;

  constructor(db: D1Database, data?: R2Bucket) {
    this.db = db;
    this.data = data;
  }

  live(): Promise<Live> {
    return cache.get("live", LIVE_TTL_MS, async () => {
      let live: Live | null = null;
      if (this.data) {
        const obj = await this.data.get("live.json");
        if (obj) live = (await obj.json()) as Live;
      } else {
        const row = await this.db.prepare("SELECT value FROM meta WHERE key = 'live'").first<{ value: string }>();
        if (row) live = JSON.parse(row.value) as Live;
      }
      if (!live) throw new ApiError(503, "no_live_run", "No run is published yet (live.json is missing).");
      return live;
    });
  }

  /** A `docs` row's body: the exact response text the loader stored (JSON.stringify of the response). */
  private docText(runId: string, name: string): Promise<string | null> {
    return cache.get(`doc:${runId}:${name}`, DATA_TTL_MS, async () => {
      const row = await this.db
        .prepare("SELECT body FROM docs WHERE run_id = ? AND name = ?")
        .bind(runId, name)
        .first<{ body: string }>();
      return row ? row.body : null;
    });
  }

  private async manifest(live: Live): Promise<BundleManifest> {
    const text = await this.docText(live.run_id, "manifest");
    if (!text) throw new ApiError(503, "no_live_run", `Live run ${live.run_id} is not loaded in D1.`);
    return JSON.parse(text) as BundleManifest;
  }

  async version(live: Live): Promise<string> {
    return (await this.manifest(live)).bundle_hash;
  }

  async doc(live: Live, name: DocName): Promise<Body | null> {
    await this.manifest(live);
    return this.docText(live.run_id, name);
  }

  async fieldsPage(live: Live, q: FieldQuery): Promise<Body> {
    return JSON.stringify(fieldsPage(live.run_id, live.fixture, await this.fieldRows(live), q));
  }

  private fieldRows(live: Live): Promise<FieldRow[]> {
    return cache.get(`rows:${live.run_id}`, DATA_TTL_MS, async () => {
      await this.manifest(live);
      const cols = FIELDS.columns.filter((c) => c !== "geometry").map((c) => `f.${c}`);
      const res = await this.db
        .prepare(
          `SELECT ${cols.join(", ")}, s.awd_verdict, s.clear_looks, s.drained_hits, s.p_catch, s.dsr_signal, ` +
            `s.field_id AS s_field_id FROM fields f LEFT JOIN summaries s ON s.run_id = f.run_id AND s.field_id = f.field_id ` +
            `WHERE f.run_id = ? ORDER BY f.field_id`,
        )
        .bind(live.run_id)
        .all<Row>();
      return res.results.map((r) => {
        const { properties } = rowToField({ ...r, geometry: "null" });
        const has = r["s_field_id"] !== null;
        return {
          ...fieldRow(properties, undefined),
          awd_verdict: has ? (r["awd_verdict"] as FieldRow["awd_verdict"]) : null,
          clear_looks: has ? (r["clear_looks"] as number) : null,
          drained_hits: has ? (r["drained_hits"] as number) : null,
          p_catch: has ? (r["p_catch"] as number) : null,
          dsr_signal: has ? (r["dsr_signal"] as FieldRow["dsr_signal"]) : null,
        };
      });
    });
  }

  async field(live: Live, fieldId: string): Promise<Body | null> {
    if (!FIELD_ID.test(fieldId)) return null;
    await this.manifest(live);
    const id = live.run_id;
    const [f, obs, s, passes] = await this.db.batch<Row>([
      this.db.prepare(`SELECT ${FIELDS.columns.join(", ")} FROM fields WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare(`SELECT ${OBSERVATIONS.columns.join(", ")} FROM observations WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare(`SELECT ${SUMMARIES.columns.join(", ")} FROM summaries WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare("SELECT pass_id, datetime FROM passes WHERE run_id = ?").bind(id),
    ]);
    const fieldRowDb = f?.results[0];
    if (!fieldRowDb) return null;
    const datetimes = new Map((passes?.results ?? []).map((p) => [p["pass_id"] as string, p["datetime"] as string]));
    const datetimeOf = (pid: string) => {
      const dt = datetimes.get(pid);
      if (dt === undefined) throw new Error(`observation references unknown pass ${pid}`);
      return dt;
    };
    // Rows come back in primary-key order (pass_id); orderedObservationRows sorts by datetime like the bundle.
    const observations = (obs?.results ?? []).map((r) => rowToObservation(r, id));
    const summaryRow = s?.results[0];
    const summary = summaryRow ? rowToSummary(summaryRow, id, live.fixture) : undefined;
    return JSON.stringify(fieldDetail(id, live.fixture, rowToField(fieldRowDb), orderedObservationRows(observations, datetimeOf), summary));
  }

  rankInputs(live: Live): Promise<RankInputs> {
    return cache.get(`rank:${live.run_id}`, DATA_TTL_MS, async () => {
      await this.manifest(live);
      const [f, s] = await this.db.batch<Row>([
        this.db.prepare(`SELECT ${FIELDS.columns.join(", ")} FROM fields WHERE run_id = ? ORDER BY field_id`).bind(live.run_id),
        this.db.prepare(`SELECT ${SUMMARIES.columns.join(", ")} FROM summaries WHERE run_id = ?`).bind(live.run_id),
      ]);
      const summaries = new Map<string, FieldSummary>();
      for (const r of s?.results ?? []) summaries.set(r["field_id"] as string, rowToSummary(r, live.run_id, live.fixture));
      return { index: fieldIndex((f?.results ?? []).map(rowToField)), summaries };
    });
  }
}
