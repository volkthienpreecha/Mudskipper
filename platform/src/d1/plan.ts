/**
 * The D1 load, as data: which rows a run needs, which of them differ from what the database holds, and the
 * guarded upserts that write exactly those. Shared by scripts/load-d1.ts (Node, local or remote D1 through
 * wrangler's platform proxy) and the workerd tests (env.DB), so the CLI and the tests run the same code.
 *
 * Rows-written budget (free plan: 100,000 per day, DECISIONS.md F-007): tables are WITHOUT ROWID with no
 * secondary index, so one changed row costs one write. Unchanged rows cost nothing twice over: they are not
 * sent (the diff), and if they were, the upsert's WHERE guard turns them into no-ops.
 */
import type { BundleManifest } from "../repo/types.ts";
import type { ApiDocs, RunData } from "../shapes.ts";
import {
  DOCS,
  FIELDS,
  OBSERVATIONS,
  PASSES,
  SUMMARIES,
  fieldToRow,
  observationToRow,
  passToRow,
  summaryToRow,
  type Cell,
  type Row,
  type TableDef,
} from "./tables.ts";

/** D1 caps bound parameters per statement at 100. */
export const MAX_PARAMS = 100;
/** Statements per db.batch() call. */
export const BATCH_SIZE = 50;
/** Writes per changed row: WITHOUT ROWID primary-key b-tree only, no secondary indexes (migrations/0001). */
export const WRITES_PER_ROW = 1;

export interface Statement {
  sql: string;
  params: Cell[];
}

export interface TablePlan {
  def: TableDef;
  rows: Row[];
}

/** Every row the run needs, per table. `docs` holds the run-level responses and the bundle manifest. */
export function planRun(run: RunData, docs: ApiDocs, manifest: BundleManifest): TablePlan[] {
  const id = run.run_id;
  const docRows: Row[] = [];
  const named: [string, object | null][] = [
    ["meta", docs.meta], ["story", docs.story], ["passes", docs.passes], ["detectability", docs.detectability],
    ["states", docs.states], ["checks", docs.checks], ["provenance", docs.provenance],
    ["manifest", manifest],
  ];
  for (const [name, body] of named) if (body) docRows.push({ run_id: id, name, body: JSON.stringify(body) });
  return [
    { def: FIELDS, rows: run.fields.features.map((f) => fieldToRow(id, f)) },
    { def: PASSES, rows: run.passes.passes.map((p) => passToRow(id, p)) },
    { def: OBSERVATIONS, rows: run.observations.map((o) => observationToRow(id, o)) },
    { def: SUMMARIES, rows: (run.summaries ?? []).map((s) => summaryToRow(id, s)) },
    { def: DOCS, rows: docRows },
  ];
}

const keyOf = (def: TableDef, r: Row) => def.pk.map((c) => String(r[c])).join("\u0000");

/** Cell equality as SQLite stores it: numbers by value (REAL 1.0 equals 1), text exactly, null only null. */
function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

export interface TableDiff {
  def: TableDef;
  /** Rows to upsert (new or changed). */
  upserts: Row[];
  inserted: number;
  updated: number;
  unchanged: number;
  /** Primary keys present in the database for this run but absent from the plan. */
  deletes: Row[];
}

export function diffTable(plan: TablePlan, existing: Row[]): TableDiff {
  const { def } = plan;
  const have = new Map(existing.map((r) => [keyOf(def, r), r]));
  const want = new Set<string>();
  const upserts: Row[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of plan.rows) {
    const k = keyOf(def, row);
    want.add(k);
    const old = have.get(k);
    if (!old) {
      inserted++;
      upserts.push(row);
    } else if (def.columns.some((c) => !sameCell(row[c], old[c]))) {
      updated++;
      upserts.push(row);
    } else unchanged++;
  }
  const deletes = existing.filter((r) => !want.has(keyOf(def, r))).map((r) => Object.fromEntries(def.pk.map((c) => [c, r[c] ?? null])));
  return { def, upserts, inserted, updated, unchanged, deletes };
}

/** Rows written if the diff is applied. */
export function expectedWrites(diffs: TableDiff[]): number {
  return diffs.reduce((n, d) => n + (d.upserts.length + d.deletes.length) * WRITES_PER_ROW, 0);
}

/**
 * Multi-row `INSERT … ON CONFLICT(pk) DO UPDATE … WHERE <any column differs>`, at most MAX_PARAMS bound
 * parameters per statement. The WHERE guard makes an unchanged row a no-op (0 rows written).
 */
export function upsertStatements(def: TableDef, rows: Row[], maxRowsPerStatement = Infinity): Statement[] {
  const cols = def.columns;
  const nonKey = cols.filter((c) => !def.pk.includes(c));
  const perStmt = Math.max(1, Math.min(maxRowsPerStatement, Math.floor(MAX_PARAMS / cols.length)));
  const set = nonKey.map((c) => `${c} = excluded.${c}`).join(", ");
  const guard = nonKey.map((c) => `${def.name}.${c} IS NOT excluded.${c}`).join(" OR ");
  const tuple = `(${cols.map(() => "?").join(", ")})`;
  const out: Statement[] = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const chunk = rows.slice(i, i + perStmt);
    out.push({
      sql:
        `INSERT INTO ${def.name} (${cols.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")} ` +
        `ON CONFLICT (${def.pk.join(", ")}) DO UPDATE SET ${set} WHERE ${guard}`,
      params: chunk.flatMap((r) => cols.map((c) => r[c] ?? null)),
    });
  }
  return out;
}

export function deleteStatements(def: TableDef, keys: Row[]): Statement[] {
  const per = Math.floor(MAX_PARAMS / def.pk.length);
  const out: Statement[] = [];
  for (let i = 0; i < keys.length; i += per) {
    const chunk = keys.slice(i, i + per);
    const cond = chunk.map(() => `(${def.pk.map((c) => `${c} = ?`).join(" AND ")})`).join(" OR ");
    out.push({ sql: `DELETE FROM ${def.name} WHERE ${cond}`, params: chunk.flatMap((k) => def.pk.map((c) => k[c] ?? null)) });
  }
  return out;
}

/** Docs bodies can be tens of kB each; one per statement keeps every statement well under D1's 100 kB. */
const ROWS_PER_STATEMENT: Record<string, number> = { docs: 1 };

export function diffStatements(diffs: TableDiff[]): Statement[] {
  return diffs.flatMap((d) => [
    ...deleteStatements(d.def, d.deletes),
    ...upsertStatements(d.def, d.upserts, ROWS_PER_STATEMENT[d.def.name]),
  ]);
}

/** Upserts for every planned row regardless of the diff (used to prove the WHERE guard writes nothing). */
export function fullStatements(plans: TablePlan[]): Statement[] {
  return plans.flatMap((p) => upsertStatements(p.def, p.rows, ROWS_PER_STATEMENT[p.def.name]));
}

/** The minimal D1 surface the loader needs (env.DB in workerd, the platform proxy's DB in Node). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
  };
  batch(statements: unknown[]): Promise<{ meta: { rows_written?: number; changes?: number } }[]>;
}

export async function readExisting(db: D1Like, def: TableDef, runId: string): Promise<Row[]> {
  const res = await db.prepare(`SELECT ${def.columns.join(", ")} FROM ${def.name} WHERE run_id = ?`).bind(runId).all<Row>();
  return res.results;
}

export async function diffRun(db: D1Like, plans: TablePlan[], runId: string): Promise<TableDiff[]> {
  const out: TableDiff[] = [];
  for (const plan of plans) out.push(diffTable(plan, await readExisting(db, plan.def, runId)));
  return out;
}

export interface ExecResult {
  statements: number;
  batches: number;
  rowsWritten: number;
}

export async function execute(
  db: D1Like,
  statements: Statement[],
  onProgress?: (done: number, total: number) => void,
): Promise<ExecResult> {
  let rowsWritten = 0;
  let batches = 0;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    const results = await db.batch(chunk.map((s) => db.prepare(s.sql).bind(...s.params)));
    for (const r of results) rowsWritten += r.meta.rows_written ?? 0;
    batches++;
    onProgress?.(Math.min(i + BATCH_SIZE, statements.length), statements.length);
  }
  return { statements: statements.length, batches, rowsWritten };
}

/** Point the D1 copy of live.json at a run (guarded: 0 writes when it already does). */
export function liveStatement(live: object): Statement {
  return {
    sql: "INSERT INTO meta (key, value) VALUES ('live', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE meta.value IS NOT excluded.value",
    params: [JSON.stringify(live)],
  };
}
