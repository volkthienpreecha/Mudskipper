/**
 * What a run directory has and lacks before publish, by who produces each file (CONTRACTS.md B3), so
 * `publish --run <id> --dry-run` can say exactly what is missing and who it is waiting on.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PARAM_SOURCES } from "@mudskipper/core";

export interface Requirement {
  file: string;
  owner: string;
  how: string;
  /** Produced by publish itself (core outputs, district table), so its absence does not block. */
  produced?: boolean;
  optional?: boolean;
}

export const REQUIREMENTS: Requirement[] = [
  { file: "aoi.json", owner: "geo (Karthik)", how: "make grid RUN_ID=<id>" },
  { file: "fields.geojson", owner: "geo (Karthik)", how: "make fields RUN_ID=<id>" },
  { file: "fields.pmtiles", owner: "geo (Karthik)", how: "make fields RUN_ID=<id>", optional: true },
  { file: "passes.json", owner: "pipeline (Ishaan)", how: "pipeline/search.py" },
  { file: "observations.jsonl", owner: "pipeline (Ishaan)", how: "pipeline/zonal.py + classify.py" },
  { file: "provenance.json", owner: "pipeline (Ishaan)", how: "pipeline/provenance.py" },
  { file: "overlays/index.json", owner: "pipeline (Ishaan)", how: "pipeline/overlays.py" },
  { file: "hist/", owner: "pipeline (Ishaan)", how: "pipeline/classify.py", optional: true },
  { file: "checks.json", owner: "pipeline (Ishaan)", how: "pipeline/checks.py (Day 2)", optional: true },
  { file: "claims.sample.geojson", owner: "geo (Karthik)", how: "make claims RUN_ID=<id>", optional: true },
  { file: "detectability.json", owner: "core", how: "publish step 1 (core/scripts/compute-run.ts)", produced: true },
  { file: "field_summary.jsonl", owner: "core", how: "publish step 1", produced: true },
  { file: "story.json", owner: "core", how: "publish step 1", produced: true },
  { file: "states.json", owner: "core", how: "publish step 1", produced: true },
  { file: "district_check.json", owner: "geo (Karthik)", how: "publish step 1 (make district)", produced: true },
];

export interface Preflight {
  lines: string[];
  /** Files that must exist before publish can run and do not. */
  blocking: Requirement[];
  /** Real-run validation blockers that are not files (e.g. a parameter without a citation). */
  notes: string[];
}

export function preflight(runDir: string, fixture: boolean): Preflight {
  const lines: string[] = [];
  const blocking: Requirement[] = [];
  const has = (f: string) =>
    f.endsWith("/") ? existsSync(join(runDir, f)) && readdirSync(join(runDir, f)).length > 0 : existsSync(join(runDir, f));
  if (!existsSync(runDir)) {
    lines.push(`   ✗ ${runDir} does not exist`);
    return { lines, blocking: REQUIREMENTS.filter((r) => !r.optional && !r.produced), notes: [] };
  }
  for (const r of REQUIREMENTS) {
    const ok = has(r.file);
    const mark = ok ? "✓" : r.produced ? "·" : r.optional ? "○" : "✗";
    const tail = ok ? "" : r.produced ? `  (made by ${r.how})` : `  missing: ${r.owner}, ${r.how}${r.optional ? " (optional)" : ""}`;
    lines.push(`   ${mark} ${r.file.padEnd(22)}${tail}`);
    if (!ok && !r.optional && !r.produced) blocking.push(r);
  }
  const notes: string[] = [];
  if (!fixture) {
    for (const [key, src] of Object.entries(DEFAULT_PARAM_SOURCES)) {
      if ((src as { status: string }).status === "needs_citation") {
        notes.push(`detectability param ${key} is needs_citation: validate.py fails a real run until it is cited (Ishaan, DECISIONS.md parameters table).`);
      }
    }
  }
  return { lines, blocking, notes };
}
