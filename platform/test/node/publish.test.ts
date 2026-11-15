// publish.ts preflight and dry run: never touches Cloudflare, explains exactly what a run lacks.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { preflight } from "../../scripts/lib/preflight.ts";
import { FIXTURE_RUN, PLATFORM_ROOT } from "../../scripts/lib/run.ts";

const geoOnly = mkdtempSync(join(tmpdir(), "mudskipper-r01-"));
for (const f of ["aoi.json", "fields.geojson"]) copyFileSync(join(FIXTURE_RUN, f), join(geoOnly, f));
afterAll(() => rmSync(geoOnly, { recursive: true, force: true }));

describe("preflight", () => {
  it("the fixture run is complete", () => {
    const pf = preflight(FIXTURE_RUN, true);
    expect(pf.blocking).toEqual([]);
    expect(pf.notes).toEqual([]);
  });

  it("a geo-only run is blocked on exactly the pipeline's files", () => {
    const pf = preflight(geoOnly, false);
    expect(pf.blocking.map((b) => b.file)).toEqual(["passes.json", "observations.jsonl", "provenance.json", "overlays/index.json"]);
    expect(new Set(pf.blocking.map((b) => b.owner))).toEqual(new Set(["pipeline (Ishaan)"]));
    expect(pf.notes.join(" ")).not.toContain("needs_citation"); // every parameter is cited or derived now
  });
});

describe("publish --dry-run", () => {
  it("explains what a geo-only run is missing, exits 0 and changes nothing", () => {
    mkdirSync(join(geoOnly, "overlays"), { recursive: true });
    const res = spawnSync(process.execPath, ["scripts/publish.ts", "--run", "r01", "--run-dir", geoOnly, "--dry-run"], {
      cwd: PLATFORM_ROOT,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("✗ passes.json");
    expect(res.stdout).toContain("blocked: passes.json, observations.jsonl, provenance.json, overlays/index.json missing (waiting on pipeline (Ishaan))");
    expect(res.stdout).toContain("dry run: nothing changed");
  });

  it("refuses a real publish of an incomplete run before any step runs", () => {
    const res = spawnSync(process.execPath, ["scripts/publish.ts", "--run", "r01", "--run-dir", geoOnly, "--skip-smoke"], {
      cwd: PLATFORM_ROOT,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("publish: blocked:");
    expect(res.stdout).not.toContain("1. core outputs");
  });
});
