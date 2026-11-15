#!/usr/bin/env node
/**
 * Publish one run to https://mudskipper-nisar.pages.dev (SPEC Lane Karthik step 5; `make publish`).
 *
 *   node scripts/publish.ts --fixtures                # the sample run (make publish FIXTURES=1)
 *   node scripts/publish.ts --run r01                 # artifacts/r01 (make publish RUN_ID=r01)
 *   node scripts/publish.ts --run r01 --dry-run       # print the plan, change nothing
 *   node scripts/publish.ts --run x01 --run-dir platform/.rehearsal/x01 --branch rehearsal   # a preview only
 *
 * Production never serves a run that has not passed the smoke test (review item 3, DECISIONS.md K-318):
 * the site is deployed to a preview branch first, smoke-tested there, and only then deployed to production,
 * which is smoke-tested again. Every deployment serves the run its own /data/live.json names (for D1 too,
 * src/repo/d1.ts), so deploying production *is* the flip; nothing in shared storage changes what production
 * serves before that.
 *
 * Steps, in order (each stops the publish on failure):
 *   0. preflight: which run files exist, who owes the missing ones (the whole report on --dry-run)
 *   1. real runs: core outputs (node core/scripts/compute-run.ts <run>), the district table (make district),
 *      then compute-run again so provenance lists district_check.json too; the fixture run already has them
 *   2. python3 contracts/validate.py <run> --recompute (the repo venv; `make setup` if missing)
 *   3. refuse to re-publish a real run_id whose bytes changed (its /tiles are cached as immutable)
 *   4. build the app (npm run build -w @mudskipper/app, against the preview's origin) and the site → .site
 *   5. data backend d1 (only when DB is configured): migrations + guarded load of the run's rows, under its own
 *      run_id; R2 upload of the run files (only when DATA is configured). Neither changes what is served.
 *   6. wrangler pages deploy .site --branch <stage>   (preview: https://<stage>.mudskipper-nisar.pages.dev)
 *   7. smoke test the preview (expects this run)
 *   — with --branch other than main, the publish ends here (a preview-only publish, e.g. a rehearsal) —
 *   8. rebuild the app against the production origin (the /data bundle is unchanged), carry the previous live
 *      run's /tiles files for one release, deploy .site --branch main (production)
 *   9. smoke test production (expects this run)
 *  10. mirror live for other readers: D1 meta "live", R2 live.json
 *
 * Flags:
 *   --fixtures | --run ID     what to publish (exactly one)
 *   --run-dir DIR             where run ID lives (default artifacts/ID)
 *   --backend static|d1       default: d1 if wrangler.jsonc binds DB, else static
 *   --branch NAME             main (default): preview first, then production; any other name: that preview only
 *   --stage-branch NAME       the preview branch a production publish is smoked on first (default staging)
 *   --dry-run                 print the plan only
 *   --skip-validate           skip step 2 (never for a real run on the day)
 *   --allow-republish         allow step 3 to replace a real run with different bytes
 *   --allow-over-budget       pass through to the D1 loader
 *   --no-carry                do not keep the previous live run's /tiles files (step 8)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp, buildSite, countFiles, installApp, MAX_FILES } from "./build-site.ts";
import { carryRun, liveRunOf } from "./lib/carry.ts";
import { loadD1 } from "./load-d1.ts";
import { FIXTURE_RUN, PLATFORM_ROOT, REPO_ROOT, missingPublished, readRun } from "./lib/run.ts";
import { smoke } from "./smoke.ts";
import { preflight } from "./lib/preflight.ts";
import { ACCOUNT_ID, PRODUCTION_URL, PROJECT, d1Binding, r2Binding, readWranglerConfig, wrangler } from "./lib/wrangler.ts";

interface Step {
  name: string;
  run: () => Promise<void> | void;
  /** Production publishes only. */
  production?: boolean;
}

function sh(cmd: string, args: string[], cwd = REPO_ROOT): void {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
}

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

export const branchUrl = (branch: string) => (branch === "main" ? PRODUCTION_URL : `https://${branch}.${PROJECT}.pages.dev`);

/** Deploy .site to a Pages branch; refuses any workers.dev URL (K-002). */
function deploy(branch: string, message: string): string {
  const sha = git(["rev-parse", "HEAD"]);
  const out = wrangler(
    ["pages", "deploy", ".site", "--project-name", PROJECT, "--branch", branch, "--commit-hash", sha, "--commit-message", message, "--commit-dirty=true"],
    { quiet: true },
  );
  if (/workers\.dev/.test(out)) throw new Error("wrangler reported a workers.dev URL: this must be a Pages deployment");
  return /https:\/\/\S+\.pages\.dev/.exec(out)?.[0] ?? "(no URL in output)";
}

/** Static assets propagate within seconds: retry the smoke test briefly before failing the publish. */
async function smokeUntilOk(base: string, runId: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const res = await smoke({ base, expectRun: runId, log: attempt === 3 ? undefined : () => {} });
    if (res.ok) return res.checks.length;
    if (attempt === 3) throw new Error(`smoke test failed on ${base}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
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
      "no-carry": { type: "boolean", default: false },
      branch: { type: "string", default: "main" },
      "stage-branch": { type: "string", default: "staging" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || values.fixtures === Boolean(values.run)) {
    console.log(
      "usage: node scripts/publish.ts (--fixtures | --run ID [--run-dir DIR]) [--backend static|d1] [--branch main|NAME]\n" +
        "       [--stage-branch staging] [--dry-run] [--skip-validate] [--allow-republish] [--allow-over-budget] [--no-carry]",
    );
    process.exit(values.help ? 0 : 2);
  }
  if (values["skip-smoke"] && values.branch === "main") throw new Error("--skip-smoke is not allowed for production: it must never serve an unsmoked run");
  process.env["CLOUDFLARE_ACCOUNT_ID"] ??= ACCOUNT_ID;

  const runDir = values.fixtures ? FIXTURE_RUN : resolve(values["run-dir"] ?? join(REPO_ROOT, "artifacts", values.run!));
  const validateTarget = values.fixtures ? join(REPO_ROOT, "contracts", "fixtures") : runDir;
  const cfg = readWranglerConfig();
  const backend = values.backend ?? (d1Binding(cfg) ? "d1" : "static");
  if (backend !== "static" && backend !== "d1") throw new Error("--backend must be static or d1");
  if (backend === "d1" && !d1Binding(cfg)) throw new Error("--backend d1 needs d1_databases in wrangler.jsonc (platform/README.md)");
  const r2 = r2Binding(cfg);
  const production = values.branch === "main";
  const stage = production ? values["stage-branch"] : values.branch;
  if (stage === "main") throw new Error("--stage-branch must be a preview branch, not main");
  const stageUrl = branchUrl(stage);
  const site = join(PLATFORM_ROOT, ".site");
  let runId = "";
  let fixture = false;
  let built: ReturnType<typeof buildSite> | null = null;

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
        const res = await fetch(`${PRODUCTION_URL}/data/runs/${runId}/manifest.json`).catch(() => null);
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
      name: `4. build the app (API ${stageUrl}) and the site → platform/.site`,
      run: () => {
        built = buildSite({
          runDir,
          fixtures: values.fixtures,
          appApiBase: stageUrl,
          ...(values.fixtures ? {} : { updatedAt: new Date().toISOString().slice(0, 19) + "Z" }),
        });
        console.log(`   ${built.app}, ${built.files} files, bundle ${built.bundle.manifest.bundle_hash.slice(0, 12)}`);
      },
    },
    {
      name: `5. data backend: ${backend}${r2 ? " + R2" : ""} (loads the run; changes nothing that is served)`,
      run: async () => {
        if (backend === "d1") {
          await loadD1({ runDir, remote: true, allowOverBudget: values["allow-over-budget"], live: false });
        } else console.log("   static: the API bundle ships inside the deployment");
        if (r2) {
          const files = built!.bundle.manifest.files;
          for (const [rel, f] of Object.entries(files)) {
            wrangler(["r2", "object", "put", `${r2.bucket_name}/runs/${runId}/${rel}`, "--file", join(runDir, rel), "--content-type", f.type, "--remote"], { quiet: true });
          }
          console.log(`   R2: ${Object.keys(files).length} files under runs/${runId}/`);
        }
      },
    },
    {
      name: `6. wrangler pages deploy .site --branch ${stage} (preview)`,
      run: () => console.log(`   deployed ${deploy(stage, `publish ${runId}${fixture ? " (fixtures)" : ""} (preview)`)} → ${stageUrl}`),
    },
    {
      name: `7. smoke test the preview ${stageUrl}`,
      run: async () => {
        if (values["skip-smoke"]) return console.log("   skipped (--skip-smoke, preview only)");
        console.log(`   ${await smokeUntilOk(stageUrl, runId)} checks passed`);
      },
    },
    {
      name: `8. production: app against ${PRODUCTION_URL}, carry the previous run, deploy --branch main`,
      production: true,
      run: async () => {
        if (built!.app === "app/dist") {
          buildApp(PRODUCTION_URL);
          installApp(site, PRODUCTION_URL); // the same page assembly the smoked preview got
          console.log("   app rebuilt for the production origin (/data unchanged)");
        }
        const previous = await liveRunOf(PRODUCTION_URL).catch(() => null);
        if (values["no-carry"] || !previous || previous.run_id === runId) {
          console.log(`   carry: none (${values["no-carry"] ? "--no-carry" : previous ? `production already serves ${runId}` : "nothing live"})`);
        } else {
          const c = await carryRun(site, PRODUCTION_URL, previous.run_id);
          console.log(`   carry: run ${c.runId}'s /tiles files kept for one release (${c.files} files, ${(c.bytes / 1048576).toFixed(1)} MB)`);
        }
        const { files } = countFiles(site);
        if (files > MAX_FILES) throw new Error(`${files} files exceeds the Pages limit of ${MAX_FILES}`);
        console.log(`   deployed ${deploy("main", `publish ${runId}${fixture ? " (fixtures)" : ""}`)} (${files} files)`);
      },
    },
    {
      name: `9. smoke test production ${PRODUCTION_URL}`,
      production: true,
      run: async () => console.log(`   ${await smokeUntilOk(PRODUCTION_URL, runId)} checks passed`),
    },
    {
      name: "10. mirror live for other readers (D1 meta, R2 live.json)",
      production: true,
      run: async () => {
        if (backend === "d1") {
          await loadD1({ runDir, remote: true, live: true, migrate: false, allowOverBudget: values["allow-over-budget"] });
          console.log("   D1 meta live → " + runId);
        }
        if (r2) {
          const live = join(site, "data", "live.json");
          wrangler(["r2", "object", "put", `${r2.bucket_name}/live.json`, "--file", live, "--content-type", "application/json", "--remote"], { quiet: true });
          console.log("   R2 live.json → " + runId);
        }
        if (backend === "static" && !r2) console.log("   static: live.json went out with the production deploy (step 8)");
      },
    },
  ];

  console.log(
    `publish ${values.fixtures ? "fixtures" : values.run} → ${production ? `${stageUrl}, then ${PRODUCTION_URL}` : `${stageUrl} only`} ` +
      `(backend ${backend}${r2 ? " + R2" : ""}, account ${process.env["CLOUDFLARE_ACCOUNT_ID"]})`,
  );
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
    if (step.production && !production) continue;
    console.log(step.name);
    if (values["dry-run"]) continue;
    await step.run();
  }
  console.log(values["dry-run"] ? "dry run: nothing changed" : `published: ${production ? PRODUCTION_URL : stageUrl}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`publish: ${e.message}`);
    process.exit(1);
  });
}
