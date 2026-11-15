/**
 * Differential test, TypeScript side: run core on the cases core/scripts/differential.py wrote with the
 * Python reference, and require exact agreement (numbers compared with ===).
 *
 *   python3 core/scripts/differential.py cases.json --seed 1 && node core/scripts/differential.ts cases.json
 */
import { readFileSync } from "node:fs";
import type { FieldCollection, FieldSummaryLine } from "../src/contracts.gen.ts";
import {
  detectability,
  fieldSummary,
  parseJsonl,
  rank,
  RankError,
  readAuditBody,
  simulate,
  validateAuditRequest,
  type Look,
  type RuleParams,
  type Scenario,
} from "../src/index.ts";
import { firstDifference } from "../test/helpers.ts";

interface SimCase {
  params: RuleParams;
  passes: Record<string, { pass_id: string; datetime: string; used: boolean }>;
  obs: Array<{ pass_id: string; stage: "early" | "mid" | "late"; inferred: { state: "flooded" | "drained" | "uncertain" } }>;
  seed: number;
  n_sim: number;
  looks: Look[];
  scenario: Scenario;
  window: [string, string] | null;
  summary: unknown;
  counts: unknown;
  detectability: unknown;
}
interface RankCase {
  body: string;
  summary_ids: string[];
  expected: unknown;
  error: string | null;
}

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node core/scripts/differential.ts cases.json\n");
  process.exit(2);
}
const cases = JSON.parse(readFileSync(file, "utf8")) as { sim: SimCase[]; rank: RankCase[] };
const RUN = new URL("../../contracts/fixtures/run/", import.meta.url);
const fields = (JSON.parse(readFileSync(new URL("fields.geojson", RUN), "utf8")) as FieldCollection).features;
const all = new Map(
  parseJsonl<FieldSummaryLine>(readFileSync(new URL("field_summary.jsonl", RUN), "utf8")).map((s) => [s.field_id, s] as const),
);
const stages = { mid_start: "2026-07-15", late_start: "2026-09-10" };

const problems: string[] = [];
cases.sim.forEach((c, i) => {
  const passes = new Map(Object.entries(c.passes));
  const got = {
    summary: fieldSummary("fazilka-00001", c.obs, passes, c.params, stages, c.n_sim, c.seed, "dt"),
    counts: simulate(c.looks, c.params, c.n_sim, c.seed, c.scenario, c.window ?? undefined),
    detectability: detectability([...passes.values()], c.params, c.n_sim, c.seed),
  };
  for (const key of ["summary", "counts", "detectability"] as const) {
    const d = firstDifference(got[key], c[key]);
    if (d) problems.push(`rule case ${i} ${key}: ${d}`);
  }
});
for (const [i, c] of cases.rank.entries()) {
  const summaries = new Map(c.summary_ids.map((id) => [id, all.get(id)!] as const));
  try {
    const { request, inputHash } = await readAuditBody(c.body);
    const out = await rank(validateAuditRequest(request), inputHash, fields, summaries, "fixture", "2026-11-14T00:00:00Z", true);
    if (c.error !== null) problems.push(`ranking case ${i}: the reference rejects it (${c.error}), core accepted it`);
    else {
      const d = firstDifference(out, c.expected);
      if (d) problems.push(`ranking case ${i}: ${d}`);
    }
  } catch (err) {
    const code = err instanceof RankError ? err.code : String(err);
    if (code !== c.error) problems.push(`ranking case ${i}: core threw ${code}, the reference gave ${c.error ?? "a ranking"}`);
  }
}

for (const p of problems.slice(0, 20)) process.stdout.write(p + "\n");
process.stdout.write(
  `differential.ts: ${cases.sim.length} rule cases and ${cases.rank.length} ranking cases, ${problems.length} mismatches\n`,
);
process.exit(problems.length ? 1 : 0);
