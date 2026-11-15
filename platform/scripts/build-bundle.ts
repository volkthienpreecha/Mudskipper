#!/usr/bin/env node
/**
 * Build the static API bundle for one published run (DECISIONS.md K-003): every API response exactly as the
 * API serves it (every run document, every GET /api/fields page of every filter, every field card), the
 * binary ranking input, and the run's raw files for /tiles, under <out>/ (layout: src/bundle-layout.ts).
 *
 *   node scripts/build-bundle.ts --fixtures                       # contracts/fixtures/run → .site/data
 *   node scripts/build-bundle.ts --run ../artifacts/r01 [--out DIR] [--updated-at 2026-11-15T08:00:00Z] [--no-live]
 *
 * Every response is validated against contracts/schemas/api before anything is written; the build fails on
 * the first invalid one. Output is deterministic for the same inputs (no wall clock unless --updated-at now).
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Doc, DocName, JsonObject, Live } from "../src/contracts.ts";
import { DOC_NAMES } from "../src/contracts.ts";
import {
  LIVE_PATH,
  DATA_PREFIX,
  contentTypeOf,
  docPath,
  fieldPath,
  isTileFile,
  manifestPath,
  pageKey,
  pagePath,
  rankInputPath,
  tilePath,
} from "../src/bundle-layout.ts";
import { encodeRankInput } from "../src/repo/rank-input.ts";
import type { BundleManifest, TileFile } from "../src/repo/types.ts";
import { allFieldPages, buildApiDocs, type ApiDocs, type RunData } from "../src/shapes.ts";
import { FIXTURE_LIVE, FIXTURE_RUN, PLATFORM_ROOT, missingPublished, readRun } from "./lib/run.ts";
import { createSchemaAjv, validatorFor } from "./lib/schemas.ts";

export interface BundleResult {
  run: RunData;
  docs: ApiDocs;
  manifest: BundleManifest;
  live: Live;
  /** Bundle-relative paths (under the data root) of every file written. */
  written: string[];
  bytes: number;
}

export interface BundleOptions {
  /** Directory that becomes /data/ on the site. */
  out: string;
  /** live.json updated_at; default: the run's provenance.created_at (deterministic). */
  updatedAt?: string;
  /** Write live.json pointing at this run (default true). */
  live?: boolean;
  /** For the fixture run: copy contracts/fixtures/live.json verbatim instead of building one. */
  fixtureLive?: boolean;
}

const SCHEMA_OF: Record<DocName, string> = {
  meta: "api/meta.schema.json",
  story: "api/story.schema.json",
  passes: "api/passes.schema.json",
  detectability: "api/detectability.schema.json",
  states: "api/states.schema.json",
  checks: "api/checks.schema.json",
  provenance: "api/provenance.schema.json",
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const rel = (p: string) => p.slice(DATA_PREFIX.length + 1);

export function buildBundle(runDir: string, opts: BundleOptions): BundleResult {
  const run = readRun(runDir);
  const missing = missingPublished(run);
  if (missing.length) {
    throw new Error(
      `${runDir} is not a published run (missing ${missing.join(", ")}). ` +
        "Run core first: `node core/scripts/compute-run.ts <run_dir>` (publish.ts --run does this as step 1).",
    );
  }
  const docs = buildApiDocs(run);

  // ---- validate everything before writing anything
  const { ajv } = createSchemaAjv({ allErrors: true });
  const problems: string[] = [];
  const check = (what: string, schema: string, doc: unknown) => {
    for (const e of validatorFor(ajv, schema)(doc)) problems.push(`${what}: ${e}`);
  };
  for (const name of DOC_NAMES) if (docs[name]) check(`/api/${name}`, SCHEMA_OF[name], docs[name]);
  const filters = allFieldPages(run.run_id, run.fixture, docs.fieldRows);
  for (const f of filters) {
    f.pages.forEach((p, i) => check(`/api/fields?tile=${f.tile ?? ""}&verdict=${f.verdict ?? ""}&page=${i + 1}`, "api/fields_page.schema.json", p));
  }
  for (const [id, d] of docs.details) check(`/api/fields/${id}`, "api/field_detail.schema.json", d);
  if (problems.length) throw new Error(`bundle for ${run.run_id} has invalid responses:\n  ${problems.slice(0, 20).join("\n  ")}`);

  // ---- write
  const out = resolve(opts.out);
  const runDirOut = join(out, "runs", run.run_id);
  rmSync(runDirOut, { recursive: true, force: true });
  const written: string[] = [];
  const hashes: string[] = [];
  let bytes = 0;
  const put = (sitePath: string, data: string | Buffer) => {
    const file = join(out, rel(sitePath));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    const r = rel(sitePath);
    written.push(r);
    bytes += Buffer.byteLength(data);
    return r;
  };
  const putJson = (sitePath: string, obj: unknown) => {
    const text = JSON.stringify(obj);
    const r = put(sitePath, text);
    hashes.push(`${r}\u0000${sha256(text)}`);
  };

  const present: DocName[] = [];
  for (const name of DOC_NAMES) {
    const d = docs[name] as Doc | null;
    if (d) {
      putJson(docPath(run.run_id, name), d);
      present.push(name);
    }
  }
  const pages: Record<string, number> = {};
  for (const f of filters) {
    pages[pageKey(f.tile, f.verdict)] = f.total;
    f.pages.forEach((p, i) => putJson(pagePath(run.run_id, f.tile, f.verdict, i + 1), p));
  }
  for (const [id, d] of docs.details) putJson(fieldPath(run.run_id, id), d);
  const rankBin = Buffer.from(encodeRankInput(run.run_id, run.fields.features, run.summaries ?? []));
  const rankRel = put(rankInputPath(run.run_id), rankBin);
  hashes.push(`${rankRel}\u0000${sha256(rankBin)}`);

  const files: Record<string, TileFile> = {};
  for (const f of run.files.filter(isTileFile)) {
    const src = join(resolve(runDir), f);
    const data = readFileSync(src);
    const target = join(out, rel(tilePath(run.run_id, f)));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    written.push(rel(tilePath(run.run_id, f)));
    bytes += data.byteLength;
    files[f] = { size: data.byteLength, sha256: sha256(data), type: contentTypeOf(f) };
    hashes.push(`${rel(tilePath(run.run_id, f))}\u0000${files[f]!.sha256}`);
  }

  const manifest: BundleManifest = {
    v: 1,
    run_id: run.run_id,
    fixture: run.fixture,
    bundle_hash: sha256(hashes.sort().join("\n")),
    docs: present,
    fields: docs.details.size,
    pages,
    files,
  };
  put(manifestPath(run.run_id), JSON.stringify(manifest));

  let live: Live;
  if (opts.fixtureLive && run.fixture) {
    live = JSON.parse(readFileSync(FIXTURE_LIVE, "utf8")) as Live;
    if (live.run_id !== run.run_id) throw new Error(`${FIXTURE_LIVE} names run ${live.run_id}, not ${run.run_id}`);
  } else {
    const createdAt = (run.provenance as JsonObject)["created_at"] as string;
    live = { v: 1, run_id: run.run_id, fixture: run.fixture, updated_at: opts.updatedAt ?? createdAt };
  }
  check("live.json", "live.schema.json", live);
  if (problems.length) throw new Error(problems.join("\n"));
  if (opts.live !== false) put(LIVE_PATH, JSON.stringify(live, null, 2) + "\n");

  return { run, docs, manifest, live, written, bytes };
}

function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      run: { type: "string" },
      out: { type: "string", default: join(PLATFORM_ROOT, ".site", "data") },
      "updated-at": { type: "string" },
      "no-live": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || (!values.fixtures && !values.run)) {
    console.log("usage: node scripts/build-bundle.ts (--fixtures | --run DIR) [--out DIR] [--updated-at ISO|now] [--no-live]");
    process.exit(values.help ? 0 : 2);
  }
  const runDir = values.fixtures ? FIXTURE_RUN : resolve(values.run!);
  const updatedAt = values["updated-at"] === "now" ? new Date().toISOString().slice(0, 19) + "Z" : values["updated-at"];
  const t0 = performance.now();
  const r = buildBundle(runDir, {
    out: values.out,
    live: !values["no-live"],
    fixtureLive: values.fixtures,
    ...(updatedAt ? { updatedAt } : {}),
  });
  console.log(
    `bundle ${r.run.run_id}${r.run.fixture ? " (SAMPLE)" : ""}: ${r.written.length} files, ${(r.bytes / 1024).toFixed(0)} KiB, ` +
      `${r.manifest.fields} fields, docs ${r.manifest.docs.join(",")}, hash ${r.manifest.bundle_hash.slice(0, 12)} ` +
      `→ ${values.out} (${(performance.now() - t0).toFixed(0)} ms)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
