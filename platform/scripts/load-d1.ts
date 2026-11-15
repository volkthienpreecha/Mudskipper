#!/usr/bin/env node
/**
 * Load one published run into D1 with batched, guarded upserts (SPEC Lane Karthik step 5, DECISIONS F-007).
 *
 *   node scripts/load-d1.ts --fixtures --local                 # local D1 (platform/.wrangler/state), migrations applied
 *   node scripts/load-d1.ts --run ../artifacts/r01 --remote    # the real database (needs d1_databases in wrangler.jsonc)
 *
 * Flags:
 *   --local | --remote        where to load (exactly one)
 *   --dry-run                 diff and report the expected rows written; write nothing
 *   --budget N                remote rows-written budget for this load (default 90000; free plan cap is 100000/day)
 *   --allow-over-budget       load remotely even if the expected writes exceed --budget
 *   --live                    after the load, point meta "live" at this run (publish does this last)
 *   --full                    send every row, not just the diff (the WHERE guard still writes 0 for unchanged rows)
 *   --no-migrate              skip `wrangler d1 migrations apply` (it is idempotent, so the default runs it)
 *   --json                    print the report as one JSON object
 *
 * Idempotent: the plan diffs against what the database holds, and every upsert is
 * `ON CONFLICT … DO UPDATE … WHERE <some column differs>`, so a second load of the same run writes 0 rows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { diffRun, diffStatements, execute, expectedWrites, fullStatements, liveStatement, planRun, type D1Like, type TableDiff } from "../src/d1/plan.ts";
import { buildBundle } from "./build-bundle.ts";
import { FIXTURE_RUN, PLATFORM_ROOT } from "./lib/run.ts";
import { LOCAL_STATE, wrangler, writeD1Config } from "./lib/wrangler.ts";

export const DEFAULT_BUDGET = 90_000;

/** Refuse a remote load whose expected rows written exceed the daily budget (free plan: 100,000/day). */
export function assertBudget(expected: number, budget: number, remote: boolean, allowOverBudget = false): void {
  if (remote && expected > budget && !allowOverBudget) {
    throw new Error(
      `refusing remote load: ${expected} expected rows written exceeds the ${budget} budget ` +
        "(free plan: 100,000 per day). Re-run with --allow-over-budget, or load on another day.",
    );
  }
}

export interface LoadOptions {
  runDir: string;
  remote: boolean;
  dryRun?: boolean;
  budget?: number;
  allowOverBudget?: boolean;
  live?: boolean;
  full?: boolean;
  migrate?: boolean;
  /** Local persistence root (wrangler's --persist-to); default platform/.wrangler/state. */
  persistTo?: string;
  log?: (line: string) => void;
}

export interface LoadReport {
  run_id: string;
  target: "local" | "remote";
  tables: { table: string; planned: number; inserted: number; updated: number; unchanged: number; deleted: number }[];
  expected_rows_written: number;
  rows_written: number | null;
  statements: number;
  budget: number;
  dry_run: boolean;
  live: boolean;
}

export async function loadD1(opts: LoadOptions): Promise<LoadReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const persistTo = opts.persistTo ?? LOCAL_STATE;
  const configPath = writeD1Config(opts.remote);

  if (opts.migrate !== false) {
    const where = opts.remote ? ["--remote"] : ["--local", "--persist-to", persistTo];
    log(`applying migrations (${opts.remote ? "remote" : "local"})…`);
    wrangler(["d1", "migrations", "apply", "DB", ...where, "--config", configPath], { quiet: true });
  }

  // Same builder as the static bundle, so D1 serves identical responses.
  const scratch = mkdtempSync(join(tmpdir(), "mudskipper-d1-"));
  const bundle = buildBundle(opts.runDir, { out: scratch, live: false });
  rmSync(scratch, { recursive: true, force: true });
  const plans = planRun(bundle.run, bundle.docs, bundle.manifest);

  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    envFiles: [],
    persist: opts.remote ? false : { path: join(persistTo, "v3") },
    remoteBindings: opts.remote,
  });
  try {
    const db = proxy.env.DB as unknown as D1Like;
    const diffs: TableDiff[] = await diffRun(db, plans, bundle.run.run_id);
    const expected = expectedWrites(diffs);
    const report: LoadReport = {
      run_id: bundle.run.run_id,
      target: opts.remote ? "remote" : "local",
      tables: diffs.map((d, i) => ({
        table: d.def.name,
        planned: plans[i]!.rows.length,
        inserted: d.inserted,
        updated: d.updated,
        unchanged: d.unchanged,
        deleted: d.deletes.length,
      })),
      expected_rows_written: expected,
      rows_written: null,
      statements: 0,
      budget,
      dry_run: opts.dryRun === true,
      live: false,
    };
    for (const t of report.tables) {
      log(`  ${t.table.padEnd(13)} planned ${String(t.planned).padStart(6)}  new ${String(t.inserted).padStart(6)}  changed ${String(t.updated).padStart(6)}  unchanged ${String(t.unchanged).padStart(6)}  deleted ${String(t.deleted).padStart(5)}`);
    }
    log(`expected rows written: ${expected} (budget ${budget}/day on remote)`);
    assertBudget(expected, budget, opts.remote, opts.allowOverBudget);
    if (opts.dryRun) return report;

    const statements = opts.full ? fullStatements(plans) : diffStatements(diffs);
    const res = await execute(db, statements, (done, total) => {
      if (total > 200 && (done % 1000 < 50 || done === total)) log(`  ${done}/${total} statements`);
    });
    report.statements = res.statements;
    report.rows_written = res.rowsWritten;
    if (opts.live) {
      const live = await execute(db, [liveStatement(bundle.live)]);
      report.rows_written += live.rowsWritten;
      report.live = true;
    }
    log(`rows written: ${report.rows_written} in ${res.batches} batches (${res.statements} statements)`);
    return report;
  } finally {
    await proxy.dispose();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      run: { type: "string" },
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      budget: { type: "string" },
      "allow-over-budget": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      "no-migrate": { type: "boolean", default: false },
      "persist-to": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || values.local === values.remote || (!values.fixtures && !values.run)) {
    console.log(
      "usage: node scripts/load-d1.ts (--fixtures | --run DIR) (--local | --remote) [--dry-run] [--budget N]\n" +
        "       [--allow-over-budget] [--live] [--full] [--no-migrate] [--persist-to DIR] [--json]",
    );
    process.exit(values.help ? 0 : 2);
  }
  const report = await loadD1({
    runDir: values.fixtures ? FIXTURE_RUN : resolve(values.run!),
    remote: values.remote,
    dryRun: values["dry-run"],
    allowOverBudget: values["allow-over-budget"],
    live: values.live,
    full: values.full,
    migrate: !values["no-migrate"],
    ...(values.budget ? { budget: Number(values.budget) } : {}),
    ...(values["persist-to"] ? { persistTo: resolve(values["persist-to"]) } : {}),
    ...(values.json ? { log: () => {} } : {}),
  });
  if (values.json) console.log(JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.chdir(PLATFORM_ROOT);
  main().catch((e: Error) => {
    console.error(`load-d1: ${e.message}`);
    process.exit(1);
  });
}
