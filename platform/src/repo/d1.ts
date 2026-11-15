/**
 * D1Repo: serves the API from the SPEC B4 tables (migrations/0001_init.sql).
 *
 * One version at a time, never a mix (review item 11, DECISIONS.md K-317):
 *
 * - The live run and the version it must be are the deployment's own: `/data/live.json` and that run's
 *   `/data/runs/<id>/manifest.json` ship inside every Pages deployment (the bundle builder writes them for
 *   both backends), so a preview deployment can serve a new run while production still serves the old one,
 *   and "flipping live" is deploying production (scripts/publish.ts). R2 `live.json` and D1 `meta.live` are
 *   mirrors written after the production smoke test, for other readers.
 * - Every read checks that D1 holds exactly that version: the `docs` manifest's bundle_hash is read in the same
 *   query batch as the data, and a mismatch is 503 `no_live_run` (D1 is still loading, or holds another
 *   upload of the same run_id). So an ETag (from the bundle_hash) never goes out with a body of another version.
 * - Cached values are keyed by `<run_id>:<bundle_hash>` and kept for the isolate's lifetime: a version's rows
 *   never change, and a new version has a new key.
 *
 * New content is loaded under a new run_id (publish refuses to replace a real run in place without
 * --allow-republish), so a mismatch is a transient state, not a normal one.
 */
import { fieldIndex } from "@mudskipper/core";
import type { DocName, FieldRow, FieldSummary, Live } from "../contracts.ts";
import { FIELD_ID } from "../contracts.ts";
import { ApiError } from "../http/errors.ts";
import { fieldDetail, fieldRow, fieldsPage, orderedObservationRows, type FieldQuery } from "../shapes.ts";
import { FIELDS, OBSERVATIONS, SUMMARIES, rowToField, rowToObservation, rowToSummary, type Row } from "../d1/tables.ts";
import { FOREVER, IsolateCache } from "./cache.ts";
import { StaticRepo } from "./static.ts";
import type { Body, RankInputs, Repo } from "./types.ts";

const cache = new IsolateCache(64);

export function clearD1Cache(): void {
  cache.clear();
}

const MANIFEST_SQL = "SELECT body FROM docs WHERE run_id = ? AND name = 'manifest'";

export class D1Repo implements Repo {
  readonly kind = "d1" as const;
  private readonly db: D1Database;
  /** The deployment's own bundle: live.json and the live run's manifest (the version D1 must hold). */
  private readonly deployment: StaticRepo;

  constructor(db: D1Database, assets: Fetcher, origin: string) {
    this.db = db;
    this.deployment = new StaticRepo(assets, origin);
  }

  live(): Promise<Live> {
    return this.deployment.live();
  }

  version(live: Live): Promise<string> {
    return this.deployment.version(live);
  }

  /** Run `statements` in one batch after the manifest check; throws 503 unless D1 holds `version`. */
  private async read(live: Live, statements: D1PreparedStatement[]): Promise<{ version: string; results: D1Result<Row>[] }> {
    const version = await this.version(live);
    const [m, ...results] = await this.db.batch<Row>([this.db.prepare(MANIFEST_SQL).bind(live.run_id), ...statements]);
    const body = m?.results[0]?.["body"];
    const held = typeof body === "string" ? (JSON.parse(body) as { bundle_hash?: string }).bundle_hash : undefined;
    if (held === undefined) throw new ApiError(503, "no_live_run", `Live run ${live.run_id} is not loaded in D1.`);
    if (held !== version) {
      throw new ApiError(503, "no_live_run", `D1 holds another version of run ${live.run_id} than this deployment serves; retry shortly.`);
    }
    return { version, results };
  }

  private async cached<T>(live: Live, what: string, load: () => Promise<T>): Promise<T> {
    const version = await this.version(live);
    return cache.get(`${what}:${live.run_id}:${version}`, FOREVER, load);
  }

  doc(live: Live, name: DocName): Promise<Body | null> {
    return this.cached(live, `doc:${name}`, async () => {
      const { results } = await this.read(live, [this.db.prepare("SELECT body FROM docs WHERE run_id = ? AND name = ?").bind(live.run_id, name)]);
      const body = results[0]?.results[0]?.["body"];
      return typeof body === "string" ? body : null;
    });
  }

  async fieldsPage(live: Live, q: FieldQuery): Promise<Body> {
    return JSON.stringify(fieldsPage(live.run_id, live.fixture, await this.fieldRows(live), q));
  }

  private fieldRows(live: Live): Promise<FieldRow[]> {
    return this.cached(live, "rows", async () => {
      const cols = FIELDS.columns.filter((c) => c !== "geometry").map((c) => `f.${c}`);
      const { results } = await this.read(live, [
        this.db
          .prepare(
            `SELECT ${cols.join(", ")}, s.awd_verdict, s.clear_looks, s.drained_hits, s.p_catch, s.dsr_signal, ` +
              `s.field_id AS s_field_id FROM fields f LEFT JOIN summaries s ON s.run_id = f.run_id AND s.field_id = f.field_id ` +
              `WHERE f.run_id = ? ORDER BY f.field_id`,
          )
          .bind(live.run_id),
      ]);
      return (results[0]?.results ?? []).map((r) => {
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
    const id = live.run_id;
    const { results } = await this.read(live, [
      this.db.prepare(`SELECT ${FIELDS.columns.join(", ")} FROM fields WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare(`SELECT ${OBSERVATIONS.columns.join(", ")} FROM observations WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare(`SELECT ${SUMMARIES.columns.join(", ")} FROM summaries WHERE run_id = ? AND field_id = ?`).bind(id, fieldId),
      this.db.prepare("SELECT pass_id, datetime FROM passes WHERE run_id = ?").bind(id),
    ]);
    const [f, obs, s, passes] = results;
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
    return this.cached(live, "rank", async () => {
      const { results } = await this.read(live, [
        this.db.prepare(`SELECT ${FIELDS.columns.join(", ")} FROM fields WHERE run_id = ? ORDER BY field_id`).bind(live.run_id),
        this.db.prepare(`SELECT ${SUMMARIES.columns.join(", ")} FROM summaries WHERE run_id = ?`).bind(live.run_id),
      ]);
      const [f, s] = results;
      const summaries = new Map<string, FieldSummary>();
      for (const r of s?.results ?? []) summaries.set(r["field_id"] as string, rowToSummary(r, live.run_id, live.fixture));
      return { index: fieldIndex((f?.results ?? []).map(rowToField)), summaries };
    });
  }
}
