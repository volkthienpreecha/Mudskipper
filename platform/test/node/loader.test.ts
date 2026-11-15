// The D1 loader CLI path (wrangler migrations + platform proxy) against a throwaway local D1.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, assertBudget, loadD1 } from "../../scripts/load-d1.ts";
import { FIXTURE_RUN } from "../../scripts/lib/run.ts";
import { parseJsonc, writeD1Config } from "../../scripts/lib/wrangler.ts";

const persistTo = mkdtempSync(join(tmpdir(), "mudskipper-d1-"));
afterAll(() => rmSync(persistTo, { recursive: true, force: true }));
const quiet = () => {};

describe("load-d1 --local", () => {
  it("first load: expected rows written == measured (3,620); second load writes 0; --full writes 0", async () => {
    const first = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo, log: quiet });
    expect(first.expected_rows_written).toBe(3620);
    expect(first.rows_written).toBe(3620);
    expect(first.tables.map((t) => [t.table, t.inserted])).toEqual([
      ["fields", 300],
      ["passes", 12],
      ["observations", 3000],
      ["summaries", 300],
      ["docs", 8],
    ]);

    const second = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo, migrate: false, log: quiet });
    expect(second.expected_rows_written).toBe(0);
    expect(second.rows_written).toBe(0);
    expect(second.statements).toBe(0);

    const full = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo, migrate: false, full: true, log: quiet });
    expect(full.statements).toBeGreaterThan(600);
    expect(full.rows_written).toBe(0);

    const live = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo, migrate: false, live: true, log: quiet });
    expect(live.rows_written).toBe(1);
    const liveAgain = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo, migrate: false, live: true, log: quiet });
    expect(liveAgain.rows_written).toBe(0);
  });

  it("--dry-run reports without writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mudskipper-d1-dry-"));
    try {
      const dry = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo: dir, dryRun: true, log: quiet });
      expect(dry.expected_rows_written).toBe(3620);
      expect(dry.rows_written).toBeNull();
      const after = await loadD1({ runDir: FIXTURE_RUN, remote: false, persistTo: dir, dryRun: true, migrate: false, log: quiet });
      expect(after.expected_rows_written).toBe(3620);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("remote safety", () => {
  it("refuses a remote load over the 90,000/day budget unless allowed", () => {
    expect(DEFAULT_BUDGET).toBe(90_000);
    expect(() => assertBudget(90_001, DEFAULT_BUDGET, true)).toThrow(/refusing remote load/);
    expect(() => assertBudget(90_001, DEFAULT_BUDGET, true, true)).not.toThrow();
    expect(() => assertBudget(90_000, DEFAULT_BUDGET, true)).not.toThrow();
    expect(() => assertBudget(500_000, DEFAULT_BUDGET, false)).not.toThrow();
  });

  it("refuses --remote while wrangler.jsonc has no D1 binding", () => {
    expect(() => writeD1Config(true)).toThrow(/D1 is not configured/);
  });

  it("parses JSONC with comments, trailing commas and // inside strings", () => {
    expect(parseJsonc<Record<string, unknown>>('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}')).toEqual({ a: "http://x", b: [1, 2] });
  });
});
