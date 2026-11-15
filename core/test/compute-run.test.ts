/**
 * scripts/compute-run.ts end to end, on a copy of the fixture run's inputs (plain `node`, as the publish
 * script and CI run it). CI also runs contracts/validate.py --recompute on the same output.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Provenance } from "../src/contracts.gen.ts";
import { sha256Hex } from "../src/sha.ts";
import { assertSameJson, fixtureJson, fixtureJsonl } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/compute-run.ts", import.meta.url));
const RUN = fileURLToPath(new URL("../../contracts/fixtures/run/", import.meta.url));
const OUTPUTS = ["detectability.json", "field_summary.jsonl", "states.json", "story.json"];
const tmp = mkdtempSync(join(tmpdir(), "mudskipper-compute-run-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function inputsCopy(name: string): string {
  const dir = join(tmp, name);
  cpSync(RUN, dir, { recursive: true });
  for (const f of OUTPUTS) rmSync(join(dir, f));
  return dir;
}
const run = (...args: string[]) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const readOut = (dir: string, f: string): unknown =>
  f.endsWith(".jsonl") ? readFileSync(join(dir, f), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l)) : JSON.parse(readFileSync(join(dir, f), "utf8"));

describe("scripts/compute-run.ts", () => {
  it("writes core's four outputs equal to the fixtures and re-lists provenance artifacts", async () => {
    const dir = inputsCopy("inplace");
    const log = run(dir);
    expect(log).toContain("compute-run: fixture (fixture)");
    for (const f of OUTPUTS) {
      const expected = f.endsWith(".jsonl") ? fixtureJsonl(`run/${f}`) : fixtureJson(`run/${f}`);
      assertSameJson(readOut(dir, f), expected, f);
    }
    const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) as Provenance;
    const committed = fixtureJson<Provenance>("run/provenance.json");
    expect(prov.artifacts.map((a) => a.path)).toEqual(committed.artifacts.map((a) => a.path));
    for (const a of prov.artifacts) expect(a.sha256, a.path).toBe(await sha256Hex(new Uint8Array(readFileSync(join(dir, a.path)))));
    assertSameJson({ ...prov, artifacts: [] }, { ...committed, artifacts: [] }, "provenance (other members)");

    // T2: a rerun is byte-identical
    const before = [...OUTPUTS, "provenance.json"].map((f) => readFileSync(join(dir, f), "utf8"));
    run(dir);
    expect([...OUTPUTS, "provenance.json"].map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);
  });

  it("--out writes elsewhere and leaves the run's provenance alone", () => {
    const dir = inputsCopy("outdir");
    const out = join(tmp, "elsewhere");
    const provBefore = readFileSync(join(dir, "provenance.json"), "utf8");
    expect(run(dir, "--out", out)).toContain("provenance.json not updated");
    for (const f of OUTPUTS) expect(() => readFileSync(join(out, f))).not.toThrow();
    expect(readFileSync(join(dir, "provenance.json"), "utf8")).toBe(provBefore);
  });

  it("--seed and --n-sim change the simulation; bad input fails with exit 1", () => {
    const dir = inputsCopy("seeded");
    run(dir, "--seed", "7", "--n-sim", "500");
    const det = readOut(dir, "detectability.json") as { seed: number; n_sim: number };
    expect([det.seed, det.n_sim]).toEqual([7, 500]);

    const mixed = inputsCopy("mixed");
    const aoi = JSON.parse(readFileSync(join(mixed, "aoi.json"), "utf8"));
    delete aoi.fixture;
    writeFileSync(join(mixed, "aoi.json"), JSON.stringify(aoi));
    const r = spawnSync(process.execPath, [SCRIPT, mixed], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("some inputs are marked fixture and some are not");

    const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain("usage:");
    expect(spawnSync(process.execPath, [SCRIPT, dir, "--seed", "x"], { encoding: "utf8" }).status).toBe(1);
  });
});
