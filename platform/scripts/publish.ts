#!/usr/bin/env node
/**
 * Publish one run to https://mudskipper-nisar.pages.dev (SPEC Lane Karthik step 5; `make publish`).
 *
 *   node scripts/publish.ts --fixtures                # the sample run (make publish FIXTURES=1)
 *   node scripts/publish.ts --run r01                 # artifacts/r01 (make publish RUN_ID=r01)
 *   node scripts/publish.ts --run r01 --dry-run       # print the plan, change nothing
 *
 * Steps, in order (each stops the publish on failure; live flips last):
 *   0. preflight: which run files exist, who owes the missing ones (the whole report on --dry-run)
 *   1. real runs: core outputs (node core/scripts/compute-run.ts <run>: detectability, field_summary, states,
 *      story, provenance list), then the district table (make district, geo's uv venv), then compute-run
 *      again so provenance lists district_check.json too; the fixture run already has them
 *   2. python3 contracts/validate.py <run> --recompute (the repo venv; `make setup` if missing)
 *   3. refuse to re-publish a real run_id whose bytes changed (its /tiles are cached as immutable)
 *   4. build the static API bundle + site into platform/.site
 *   5. backend d1 (only when DB is configured): D1 migrations + guarded load (rows-written budget);
 *      R2 upload of the run files (only when DATA is configured)
 *   6. wrangler pages deploy platform/.site --project-name mudskipper-nisar --branch main (production)
 *   7. smoke test the production URL
 *   8. flip live: static → live.json shipped inside the deploy (step 6); d1 → meta "live"; r2 → live.json last
 *
 * Flags:
 *   --fixtures | --run ID     what to publish (exactly one)
 *   --run-dir DIR             where run ID lives (default artifacts/ID)
 *   --backend static|d1       default: d1 if wrangler.jsonc binds DB, else static
 *   --dry-run                 print the plan only
 *   --skip-validate           skip step 2 (never for a real run on the day)
 *   --skip-smoke              skip step 7
 *   --allow-republish         allow step 3 to replace a real run with different bytes
 *   --allow-over-budget       pass through to the D1 loader
 *   --branch NAME             Pages branch (default main = production)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSite } from "./build-site.ts";
import { loadD1 } from "./load-d1.ts";
import { FIXTURE_RUN, PLATFORM_ROOT, REPO_ROOT, missingPublished, readRun } from "./lib/run.ts";
import { smoke } from "./smoke.ts";
import { preflight } from "./lib/preflight.ts";
import { ACCOUNT_ID, PRODUCTION_URL, PROJECT, d1Binding, r2Binding, readWranglerConfig, wrangler } from "./lib/wrangler.ts";

interface Step {
  name: string;
  run: () => Promise<void> | void;
}

function sh(cmd: string, args: string[], cwd = REPO_ROOT): void {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
}

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      run: { type: "string" },
      "run-dir": { type: "string" },
      backend: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "skip-validate": { type: "boolean", default: false },
      "skip-smoke": { type: "boolean", default: false },
      "allow-republish": { type: "boolean", default: false },
      "allow-over-budget": { type: "boolean", default: false },
      branch: { type: "string", default: "main" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || values.fixtures === Boolean(values.run)) {
    console.log(
      "usage: node scripts/publish.ts (--fixtures | --run ID [--run-dir DIR]) [--backend static|d1] [--dry-run] [--skip-validate]\n" +
        "       [--skip-smoke] [--allow-republish] [--allow-over-budget] [--branch main]",
    );
    process.exit(values.help ? 0 : 2);
  }
  process.env["CLOUDFLARE_ACCOUNT_ID"] ??= ACCOUNT_ID;

  const runDir = values.fixtures ? FIXTURE_RUN : resolve(values["run-dir"] ?? join(REPO_ROOT, "artifacts", values.run!));
  const validateTarget = values.fixtures ? join(REPO_ROOT, "contracts", "fixtures") : runDir;
  const cfg = readWranglerConfig();
  const backend = values.backend ?? (d1Binding(cfg) ? "d1" : "static");
  if (backend !== "static" && backend !== "d1") throw new Error("--backend must be static or d1");
  if (backend === "d1" && !d1Binding(cfg)) throw new Error("--backend d1 needs d1_databases in wrangler.jsonc (platform/README.md)");
  const r2 = r2Binding(cfg);
  const isProduction = values.branch === "main";
  const base = isProduction ? PRODUCTION_URL : `https://${values.branch}.${PROJECT}.pages.dev`;
  let runId = "";
  let fixture = false;
  let site: ReturnType<typeof buildSite> | null = null;

  const steps: Step[] = [
    {
      name: "1. core outputs + district table",
      run: () => {
        if (values.fixtures) {
          const run = readRun(runDir);
          runId = run.run_id;
          fixture = run.fixture;
          return console.log("   fixture run: core outputs and district table are part of contracts/fixtures");
        }
        const compute = () => sh(process.execPath, [join(REPO_ROOT, "core", "scripts", "compute-run.ts"), runDir]);
        compute();
        const pre = readRun(runDir);
        if (pre.fields.features.length > 0) {
          sh("make", ["district", `RUN_ID=${pre.run_id}`, `RUN_DIR=${runDir}`]);
          compute(); // re-list provenance artifacts so district_check.json is hashed too (B3.9)
        }
        const run = readRun(runDir);
        runId = run.run_id;
        fixture = run.fixture;
        const missing = missingPublished(run);
        if (missing.length) throw new Error(`compute-run did not produce ${missing.join(", ")}`);
        console.log(`   run ${run.run_id}: core outputs written, district table ${run.district ? "written" : "skipped"}`);
      },
    },
    {
      name: `2. validate ${relative(REPO_ROOT, validateTarget)} --recompute`,
      run: () => {
        if (values["skip-validate"]) return console.log("   skipped (--skip-validate)");
        if (!existsSync(join(REPO_ROOT, ".venv", ".ready"))) sh("make", ["setup"]);
        sh(join(REPO_ROOT, ".venv", "bin", "python"), ["contracts/validate.py", relative(REPO_ROOT, validateTarget), "--recompute"]);
      },
    },
    {
      name: "3. republish guard (real runs are immutable once live)",
      run: async () => {
        if (fixture) return console.log("   fixture run: replaced in place by design");
        const res = await fetch(`${base}/data/runs/${runId}/manifest.json`).catch(() => null);
        if (!res || !res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return console.log("   not published before");
        const live = (await res.json()) as { bundle_hash: string };
        const scratch = buildSite({ runDir, out: join(PLATFORM_ROOT, ".site"), placeholder: true });
        if (scratch.bundle.manifest.bundle_hash !== live.bundle_hash && !values["allow-republish"]) {
          throw new Error(
            `run ${runId} is already published with different content; publish it under a new run_id (r02, …) ` +
              "or pass --allow-republish (browsers may keep the old /tiles for a year).",
          );
        }
        console.log("   same bytes as the published run, or --allow-republish");
      },
    },
    {
      name: "4. build bundle + site → platform/.site",
      run: () => {
        const r = (site = buildSite({
          runDir,
          fixtures: values.fixtures,
          ...(values.fixtures ? {} : { updatedAt: new Date().toISOString().slice(0, 19) + "Z" }),
        }));
        console.log(`   ${r.app}, ${r.files} files, bundle ${r.bundle.manifest.bundle_hash.slice(0, 12)}`);
      },
    },
    {
      name: `5. data backend: ${backend}${r2 ? " + R2" : ""}`,
      run: async () => {
        if (backend === "d1") {
          await loadD1({ runDir, remote: true, allowOverBudget: values["allow-over-budget"], live: false });
        } else console.log("   static: the API bundle ships inside the deployment");
        if (r2) {
          const files = site!.bundle.manifest.files;
          for (const [rel, f] of Object.entries(files)) {
            wrangler(["r2", "object", "put", `${r2.bucket_name}/runs/${runId}/${rel}`, "--file", join(runDir, rel), "--content-type", f.type, "--remote"], { quiet: true });
          }
          console.log(`   R2: ${Object.keys(files).length} files under runs/${runId}/`);
        }
      },
    },
    {
      name: `6. wrangler pages deploy .site --project-name ${PROJECT} --branch ${values.branch}`,
      run: () => {
        const sha = git(["rev-parse", "HEAD"]);
        const msg = `publish ${runId}${fixture ? " (fixtures)" : ""} @ ${sha.slice(0, 7)}`;
        const out = wrangler(
          ["pages", "deploy", ".site", "--project-name", PROJECT, "--branch", values.branch, "--commit-hash", sha, "--commit-message", msg, "--commit-dirty=true"],
          { quiet: true },
        );
        const url = /https:\/\/\S+\.pages\.dev/.exec(out)?.[0];
        console.log(`   deployed ${url ?? "(no URL in output)"}`);
        if (/workers\.dev/.test(out)) throw new Error("wrangler reported a workers.dev URL: this must be a Pages deployment");
      },
    },
    {
      name: `7. smoke test ${base}`,
      run: async () => {
        if (values["skip-smoke"]) return console.log("   skipped (--skip-smoke)");
        // Static assets propagate within seconds; retry briefly before failing the publish.
        for (let attempt = 1; ; attempt++) {
          const res = await smoke({ base, expectRun: runId, log: attempt === 3 ? undefined : () => {} });
          if (res.ok) return console.log(`   ${res.checks.length}/${res.checks.length} checks passed`);
          if (attempt === 3) throw new Error("smoke test failed");
          await new Promise((r) => setTimeout(r, 5000));
        }
      },
    },
    {
      name: "8. flip live",
      run: async () => {
        if (backend === "d1") {
          await loadD1({ runDir, remote: true, live: true, migrate: false, allowOverBudget: values["allow-over-budget"] });
          console.log("   D1 meta live → " + runId);
        }
        if (r2) {
          const live = join(PLATFORM_ROOT, ".site", "data", "live.json");
          wrangler(["r2", "object", "put", `${r2.bucket_name}/live.json`, "--file", live, "--content-type", "application/json", "--remote"], { quiet: true });
          console.log("   R2 live.json → " + runId);
        }
        if (backend === "static" && !r2) console.log("   static: live.json went out with the deploy in step 6");
      },
    },
  ];

  console.log(`publish ${values.fixtures ? "fixtures" : values.run} → ${base} (backend ${backend}${r2 ? " + R2" : ""}, account ${process.env["CLOUDFLARE_ACCOUNT_ID"]})`);
  console.log(`0. preflight ${relative(REPO_ROOT, runDir) || runDir}  (✓ present, ✗ missing and required, ○ missing and optional, · made by publish)`);
  const pf = preflight(runDir, values.fixtures);
  for (const line of pf.lines) console.log(line);
  for (const note of pf.notes) console.log(`   ! ${note}`);
  if (pf.blocking.length) {
    const owners = [...new Set(pf.blocking.map((b) => b.owner))].join(", ");
    const msg = `blocked: ${pf.blocking.map((b) => b.file).join(", ")} missing (waiting on ${owners}); nothing was changed.`;
    if (values["dry-run"]) {
      console.log(`   ${msg}`);
      console.log("dry run: the steps below would run once the run directory is complete");
    } else throw new Error(msg);
  }
  for (const step of steps) {
    console.log(step.name);
    if (values["dry-run"]) continue;
    await step.run();
  }
  console.log(values["dry-run"] ? "dry run: nothing changed" : `published: ${base}`);
}

main().catch((e: Error) => {
  console.error(`publish: ${e.message}`);
  process.exit(1);
});
