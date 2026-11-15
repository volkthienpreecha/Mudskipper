/**
 * Compute core's outputs for one run directory (what the publish script runs; SPEC A4, CONTRACTS.md B3).
 *
 *   node core/scripts/compute-run.ts <run_dir> [--out DIR] [--seed N] [--n-sim N]
 *
 * Reads aoi.json, fields.geojson, passes.json and observations.jsonl from <run_dir> and writes
 * detectability.json, field_summary.jsonl, states.json and story.json (to <run_dir>, or to --out DIR).
 * When writing into the run directory, it also rewrites provenance.json's `artifacts` list (B3.9): every
 * other file, sorted, with its sha256. Parameters are core's DEFAULT_PARAMS; seed and n_sim default to
 * DEFAULT_SEED and DEFAULT_N_SIM. Outputs are byte-identical on reruns (T2).
 *
 * Runs on plain Node ≥ 24 (built-in TypeScript type stripping); no build step.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  computeRun,
  DEFAULT_N_SIM,
  DEFAULT_SEED,
  dumpJson,
  dumpJsonl,
  dumpStates,
  parseJsonl,
  provenanceArtifacts,
  withArtifacts,
  type Aoi,
  type FieldCollection,
  type ObservationLine,
  type Passes,
  type Provenance,
} from "../src/index.ts";

const USAGE = "usage: node core/scripts/compute-run.ts <run_dir> [--out DIR] [--seed N] [--n-sim N]";

function fail(message: string): never {
  process.stderr.write(`compute-run: ${message}\n`);
  process.exit(1);
}

function intOption(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) fail(`--${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.compute-run.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)).split(sep).join("/"));
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string" },
        seed: { type: "string" },
        "n-sim": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  }
  if (parsed.values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (parsed.positionals.length !== 1) fail(USAGE);
  const runDir = resolve(parsed.positionals[0]!);
  const outDir = resolve(parsed.values.out ?? runDir);
  const seed = intOption("seed", parsed.values.seed, DEFAULT_SEED);
  const nSim = intOption("n-sim", parsed.values["n-sim"], DEFAULT_N_SIM);

  const aoi = readJson<Aoi>(join(runDir, "aoi.json"));
  const fields = readJson<FieldCollection>(join(runDir, "fields.geojson"));
  const passesDoc = readJson<Passes>(join(runDir, "passes.json"));
  let observations: ObservationLine[];
  try {
    observations = parseJsonl<ObservationLine>(readFileSync(join(runDir, "observations.jsonl"), "utf8"));
  } catch (err) {
    fail(`cannot read observations.jsonl: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Header checks: one run_id, and the fixture flag the same everywhere (C0).
  const headers = [aoi, fields, passesDoc, ...observations];
  const runIds = new Set(headers.map((h) => h.run_id));
  if (runIds.size !== 1) fail(`inputs disagree on run_id: ${[...runIds].join(", ")}`);
  const flags = new Set(headers.map((h) => h.fixture === true));
  if (flags.size !== 1) fail("some inputs are marked fixture and some are not");
  const runId = aoi.run_id;
  const fixture = flags.has(true) ? true : undefined;

  let out;
  try {
    out = computeRun({ aoi, fields, passes: passesDoc.passes, observations, runId, seed, nSim, ...(fixture ? { fixture } : {}) });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  mkdirSync(outDir, { recursive: true });
  writeAtomic(join(outDir, "detectability.json"), dumpJson(out.detectability));
  writeAtomic(join(outDir, "field_summary.jsonl"), dumpJsonl(out.summaries));
  writeAtomic(join(outDir, "states.json"), dumpStates(out.states));
  writeAtomic(join(outDir, "story.json"), dumpJson(out.story));

  let provenanceNote = `provenance.json not updated (outputs written outside ${runDir})`;
  if (outDir === runDir) {
    const provPath = join(runDir, "provenance.json");
    const provenance = readJson<Provenance>(provPath);
    const files = listFiles(runDir)
      .filter((p) => p !== "provenance.json")
      .map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(runDir, path))) }));
    const artifacts = await provenanceArtifacts(files);
    writeAtomic(provPath, dumpJson(withArtifacts(provenance, artifacts)));
    provenanceNote = `provenance.json lists ${artifacts.length} artifacts`;
  }

  const counts: Record<string, number> = {};
  for (const s of out.summaries) counts[s.awd.verdict] = (counts[s.awd.verdict] ?? 0) + 1;
  process.stdout.write(
    [
      `compute-run: ${runId}${fixture ? " (fixture)" : ""} -> ${outDir}`,
      `  passes used: ${out.detectability.pass_dates.length}, fields: ${out.summaries.length}, seed ${seed}, n_sim ${nSim}`,
      `  verdicts: ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`,
      `  k*: ${out.detectability.results.k_star}; ${out.detectability.sentence}`,
      `  story: ${out.story.headline.text} (hero ${out.story.hero_field_id})`,
      `  ${provenanceNote}`,
    ].join("\n") + "\n",
  );
}

await main();
