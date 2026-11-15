/** Read a run directory (artifacts/<run_id>/ or contracts/fixtures/run/) into the shape src/shapes.ts builds from. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Doc, FieldSummary, Observation } from "../../src/contracts.ts";
import type { RunData } from "../../src/shapes.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PLATFORM_ROOT = join(REPO_ROOT, "platform");
export const FIXTURE_RUN = join(REPO_ROOT, "contracts", "fixtures", "run");
export const FIXTURE_LIVE = join(REPO_ROOT, "contracts", "fixtures", "live.json");

/** Every file under `dir` as a sorted list of POSIX paths relative to it. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function readJson<T>(dir: string, rel: string): T {
  try {
    return JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;
  } catch (e) {
    throw new Error(`${join(dir, rel)}: ${(e as Error).message}`);
  }
}

function readOptional<T>(dir: string, rel: string): T | null {
  return existsSync(join(dir, rel)) ? readJson<T>(dir, rel) : null;
}

function readJsonl<T>(dir: string, rel: string): T[] {
  const text = readFileSync(join(dir, rel), "utf8");
  return text
    .split("\n")
    .map((line, i) => [line, i] as const)
    .filter(([line]) => line.trim() !== "")
    .map(([line, i]) => {
      try {
        return JSON.parse(line) as T;
      } catch (e) {
        throw new Error(`${join(dir, rel)} line ${i + 1}: ${(e as Error).message}`);
      }
    });
}

const PIPELINE = ["aoi.json", "fields.geojson", "passes.json", "observations.jsonl", "provenance.json"];

export function readRun(dirIn: string): RunData {
  const dir = resolve(dirIn);
  for (const f of PIPELINE) if (!existsSync(join(dir, f))) throw new Error(`${dir}: missing ${f} (not a run directory)`);
  const aoi = readJson<Doc>(dir, "aoi.json");
  const run_id = aoi.run_id;
  const fixture = (aoi as { fixture?: boolean }).fixture === true;
  return {
    run_id,
    fixture,
    aoi,
    fields: readJson<RunData["fields"]>(dir, "fields.geojson"),
    passes: readJson<RunData["passes"]>(dir, "passes.json"),
    observations: readJsonl<Observation>(dir, "observations.jsonl"),
    summaries: existsSync(join(dir, "field_summary.jsonl")) ? readJsonl<FieldSummary>(dir, "field_summary.jsonl") : null,
    detectability: readOptional<Doc>(dir, "detectability.json"),
    story: readOptional<Doc>(dir, "story.json"),
    states: readOptional<Doc>(dir, "states.json"),
    checks: readOptional<Doc>(dir, "checks.json"),
    district: readOptional<Doc>(dir, "district_check.json"),
    provenance: readJson<Doc>(dir, "provenance.json"),
    overlays: readOptional<Doc>(dir, "overlays/index.json"),
    files: listFiles(dir),
  };
}

/** Core outputs a published run must have (CONTRACTS.md B3 "published" stage). */
export function missingPublished(run: RunData): string[] {
  const out: string[] = [];
  if (!run.summaries) out.push("field_summary.jsonl");
  if (!run.detectability) out.push("detectability.json");
  if (!run.story) out.push("story.json");
  if (!run.states) out.push("states.json");
  return out;
}
