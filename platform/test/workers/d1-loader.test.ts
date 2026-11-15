// The D1 load plan against a real local D1: expected rows written == measured, idempotency, guard, deletes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_PARAMS,
  diffRun,
  diffStatements,
  execute,
  expectedWrites,
  fullStatements,
  planRun,
  upsertStatements,
} from "../../src/d1/plan.ts";
import { OBSERVATIONS } from "../../src/d1/tables.ts";
import type { BundleManifest } from "../../src/repo/types.ts";
import { buildApiDocs, type RunData } from "../../src/shapes.ts";

async function plansFor(run: RunData) {
  const manifest = (await (await env.ASSETS.fetch("https://x/data/runs/fixture/manifest.json")).json()) as BundleManifest;
  return planRun(run, buildApiDocs(run), { ...manifest, run_id: run.run_id });
}

function renamed(runId: string): RunData {
  const run = structuredClone(env.TEST_RUN);
  run.run_id = runId;
  return run;
}

describe("D1 load plan", () => {
  it("never binds more than 100 parameters in one statement", async () => {
    const plans = await plansFor(env.TEST_RUN);
    for (const s of fullStatements(plans)) expect(s.params.length).toBeLessThanOrEqual(MAX_PARAMS);
    expect(upsertStatements(OBSERVATIONS, plans[2]!.rows)[0]!.params).toHaveLength(5 * OBSERVATIONS.columns.length);
  });

  it("first load writes exactly the expected rows; the second writes 0; a forced full upsert writes 0", async () => {
    const run = renamed("loadtest");
    const plans = await plansFor(run);
    const diffs = await diffRun(env.DB, plans, run.run_id);
    const expected = expectedWrites(diffs);
    expect(expected).toBe(300 + 12 + 3000 + 300 + 8);
    expect((await execute(env.DB, diffStatements(diffs))).rowsWritten).toBe(expected);

    const again = await diffRun(env.DB, plans, run.run_id);
    expect(expectedWrites(again)).toBe(0);
    expect(diffStatements(again)).toHaveLength(0);
    // Sending every row anyway: the ON CONFLICT … WHERE guard makes each one a no-op.
    expect((await execute(env.DB, fullStatements(plans))).rowsWritten).toBe(0);
  });

  it("a changed row costs one write and a removed field is deleted with its rows", async () => {
    const run = renamed("changetest");
    await execute(env.DB, diffStatements(await diffRun(env.DB, await plansFor(run), run.run_id)));

    const next = structuredClone(run);
    next.observations[0]!.flags = ["rfi"];
    const dropped = next.fields.features.pop()!.properties.field_id;
    next.observations = next.observations.filter((o) => o.field_id !== dropped);
    next.summaries = next.summaries!.filter((s) => s.field_id !== dropped);
    const plans = await plansFor(next);
    const diffs = await diffRun(env.DB, plans, next.run_id);
    const byTable = Object.fromEntries(diffs.map((d) => [d.def.name, d]));
    expect(byTable["observations"]!.updated).toBe(1);
    expect(byTable["observations"]!.deletes).toHaveLength(10);
    expect(byTable["fields"]!.deletes).toHaveLength(1);
    expect(byTable["summaries"]!.deletes).toHaveLength(1);
    const expected = expectedWrites(diffs);
    expect((await execute(env.DB, diffStatements(diffs))).rowsWritten).toBe(expected);
    expect(expectedWrites(await diffRun(env.DB, plans, next.run_id))).toBe(0);
  });

  it("runs coexist: loading another run leaves the fixture run untouched", async () => {
    const count = await env.DB.prepare("SELECT count(*) AS n FROM observations WHERE run_id = 'fixture'").first<{ n: number }>();
    expect(count?.n).toBe(3000);
  });
});
