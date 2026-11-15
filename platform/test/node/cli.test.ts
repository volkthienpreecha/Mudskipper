// CLI execution must work when a checkout path contains spaces, on Windows and POSIX.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PLATFORM_ROOT, REPO_ROOT } from "../../scripts/lib/run.ts";

const root = mkdtempSync(join(tmpdir(), "mudskipper cli "));
const platform = join(root, "platform");
mkdirSync(platform);
for (const folder of ["scripts", "src", "placeholder"]) cpSync(join(PLATFORM_ROOT, folder), join(platform, folder), { recursive: true });
cpSync(join(REPO_ROOT, "contracts", "fixtures"), join(root, "contracts", "fixtures"), { recursive: true });
cpSync(join(REPO_ROOT, "contracts", "schemas"), join(root, "contracts", "schemas"), { recursive: true });
writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

afterAll(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("mudskipper cli ")) throw new Error("Unexpected CLI test cleanup target");
  rmSync(root, { recursive: true, force: true });
});

function cli(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(platform, "scripts", script), ...args], { cwd: platform, encoding: "utf8" });
}

describe("platform CLI entrypoints in a checkout path with spaces", () => {
  it.each(["build-bundle.ts", "build-site.ts", "load-d1.ts", "smoke.ts", "publish.ts", "perf.ts"])("%s executes --help without a data or Cloudflare action", (script) => {
    const result = cli(script, ["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`usage: node scripts/${script}`);
  });

  it.each(["build-bundle.ts", "build-site.ts", "load-d1.ts", "smoke.ts", "perf.ts"])("%s can be imported without a CLI argv path", (script) => {
    const moduleUrl = pathToFileURL(join(platform, "scripts", script)).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `delete process.argv[1]; await import(${JSON.stringify(moduleUrl)});`], { cwd: platform, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("build-bundle actually writes the fixture manifest", () => {
    const output = join(root, "bundle output");
    const result = cli("build-bundle.ts", ["--fixtures", "--out", output]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bundle fixture (SAMPLE):");
    expect(JSON.parse(readFileSync(join(output, "runs", "fixture", "manifest.json"), "utf8"))).toMatchObject({ run_id: "fixture", fixture: true, fields: 300 });
  });

  it("the Wrangler wrapper executes its Node entry point without a shell shim", () => {
    const moduleUrl = pathToFileURL(join(platform, "scripts", "lib", "wrangler.ts")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `const { wrangler } = await import(${JSON.stringify(moduleUrl)}); console.log(wrangler(["--version"], { quiet: true }));`], { cwd: platform, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("build-site actually writes a complete local site", () => {
    const output = join(root, "site output");
    const result = cli("build-site.ts", ["--fixtures", "--placeholder", "--out", output]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("placeholder + /data bundle for fixture");
    expect(readFileSync(join(output, "index.html"), "utf8")).toContain("<!doctype html>");
    expect(JSON.parse(readFileSync(join(output, "data", "live.json"), "utf8"))).toMatchObject({ run_id: "fixture", fixture: true });
  });
});
