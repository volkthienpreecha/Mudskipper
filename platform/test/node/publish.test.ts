// publish.ts preflight and dry run: never touches Cloudflare, explains exactly what a run lacks.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { preflight, validatorPython } from "../../scripts/lib/preflight.ts";
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

describe("repository validator interpreter", () => {
  it.each([
    ["linux", "bin", "python"],
    ["win32", "Scripts", "python.exe"],
  ] as const)("uses the %s venv interpreter", (platform, directory, executable) => {
    const root = join(geoOnly, platform);
    const interpreter = join(root, ".venv", directory, executable);
    mkdirSync(join(root, ".venv", directory), { recursive: true });
    writeFileSync(interpreter, "test interpreter path");
    expect(validatorPython(root, platform)).toBe(interpreter);
  });

  it("fails closed when the repository venv interpreter is absent", () => {
    expect(() => validatorPython(join(geoOnly, "missing"), "win32")).toThrow(/repository validator.*contracts\/requirements.txt/i);
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
    const res = spawnSync(process.execPath, ["scripts/publish.ts", "--run", "r01", "--run-dir", geoOnly], {
      cwd: PLATFORM_ROOT,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("publish: blocked:");
    expect(res.stdout).not.toContain("1. core outputs");
  });

  const plan = (args: string[]) => {
    const res = spawnSync(process.execPath, ["scripts/publish.ts", "--fixtures", "--dry-run", ...args], { cwd: PLATFORM_ROOT, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    return res.stdout.split("\n").filter((l) => /^\d+\. /.test(l));
  };

  it("review item 3: production is deployed only after the same site passed the smoke test on a preview", () => {
    const steps = plan([]);
    const at = (prefix: string) => steps.findIndex((l) => l.startsWith(prefix));
    expect(steps[at("6.")]).toContain("--branch staging (preview)");
    expect(steps[at("7.")]).toContain("smoke test the preview https://staging.mudskipper-nisar.pages.dev");
    expect(steps[at("8.")]).toContain("deploy --branch main");
    expect(steps[at("9.")]).toContain("smoke test production https://mudskipper-nisar.pages.dev");
    expect(at("6.")).toBeLessThan(at("7."));
    expect(at("7.")).toBeLessThan(at("8."));
    expect(at("8.")).toBeLessThan(at("9."));
    expect(at("9.")).toBeLessThan(at("10."));
  });

  it("a preview-only publish never touches production, and production cannot skip its smoke test", () => {
    const steps = plan(["--branch", "rehearsal"]);
    expect(steps.some((l) => l.startsWith("6.") && l.includes("--branch rehearsal"))).toBe(true);
    expect(steps.some((l) => /^(8|9|10)\./.test(l))).toBe(false);
    const res = spawnSync(process.execPath, ["scripts/publish.ts", "--fixtures", "--skip-smoke"], { cwd: PLATFORM_ROOT, encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--skip-smoke is not allowed for production");
  });
});

describe("carryRun (review item 3: keep the previous run's /tiles for one release)", () => {
  it("copies the old run's manifest and files with their hashes checked, and refuses a corrupted file", async () => {
    const { buildBundle } = await import("../../scripts/build-bundle.ts");
    const { carryRun } = await import("../../scripts/lib/carry.ts");
    const src = mkdtempSync(join(tmpdir(), "mudskipper-carry-src-"));
    buildBundle(FIXTURE_RUN, { out: join(src, "data"), fixtureLive: true });
    const served = (corrupt: boolean) => async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (corrupt && path.endsWith("/hist/early.png")) return new Response(new Uint8Array([1, 2, 3]));
      try {
        return new Response(readFileSync(join(src, path)), { headers: { "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    };
    const real = globalThis.fetch;
    const out = mkdtempSync(join(tmpdir(), "mudskipper-carry-out-"));
    writeFileSync(join(out, "_headers"), "");
    try {
      globalThis.fetch = served(false) as typeof fetch;
      const c = await carryRun(out, "https://old.example", "fixture");
      expect(c.files).toBe(10); // 9 /tiles files + the manifest
      expect(readFileSync(join(out, "data/runs/fixture/fields.geojson")).equals(readFileSync(join(FIXTURE_RUN, "fields.geojson")))).toBe(true);
      expect(readFileSync(join(out, "_headers"), "utf8")).toContain("/data/runs/fixture/*");
      globalThis.fetch = served(true) as typeof fetch;
      await expect(carryRun(mkdtempSync(join(tmpdir(), "mudskipper-carry-bad-")), "https://old.example", "fixture")).rejects.toThrow(/sha256/);
    } finally {
      globalThis.fetch = real;
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
