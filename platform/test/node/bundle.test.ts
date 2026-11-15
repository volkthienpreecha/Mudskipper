// The static API bundle: equal to contracts/fixtures/api by parsed value, deterministic, refuses bad runs.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBundle } from "../../scripts/build-bundle.ts";
import { FIXTURE_RUN, REPO_ROOT, listFiles } from "../../scripts/lib/run.ts";
import { createSchemaAjv, validatorFor } from "../../scripts/lib/schemas.ts";

const API = join(REPO_ROOT, "contracts", "fixtures", "api");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mudskipper-bundle-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("build-bundle on the fixture run", () => {
  const out = tmp();
  const result = buildBundle(FIXTURE_RUN, { out, fixtureLive: true });
  const run = join(out, "runs", "fixture");

  it.each(["meta", "story", "passes", "detectability", "states", "checks", "provenance"])(
    "api/%s.json equals contracts/fixtures/api/%s.json",
    (name) => {
      expect(read(join(run, "api", `${name}.json`))).toStrictEqual(read(join(API, `${name}.json`)));
    },
  );

  it("fields rows equal the fixture's GET /api/fields page", () => {
    expect(read(join(run, "api", "fields.json"))["rows"]).toStrictEqual(read(join(API, "fields.json"))["fields"]);
  });

  it("the hero field shard equals the fixture field card", () => {
    expect(read(join(run, "api", "fields", "fazilka-00114.json"))).toStrictEqual(read(join(API, "field.fazilka-00114.json")));
  });

  it("writes one shard per field, each schema-valid", () => {
    const { ajv } = createSchemaAjv();
    const validate = validatorFor(ajv, "api/field_detail.schema.json");
    const shards = readdirSync(join(run, "api", "fields"));
    expect(shards).toHaveLength(300);
    for (const s of shards) expect(validate(read(join(run, "api", "fields", s)))).toEqual([]);
  });

  it("live.json is the fixture live.json, and the manifest lists only /tiles files", () => {
    expect(read(join(out, "live.json"))).toStrictEqual(read(join(REPO_ROOT, "contracts", "fixtures", "live.json")));
    expect(result.manifest.docs).toHaveLength(7);
    expect(Object.keys(result.manifest.files)).not.toContain("observations.jsonl");
    expect(result.manifest.files["fields.geojson"]?.type).toBe("application/geo+json");
  });

  it("is deterministic: a second build is byte-identical", () => {
    const again = tmp();
    const r2 = buildBundle(FIXTURE_RUN, { out: again, fixtureLive: true });
    expect(r2.manifest.bundle_hash).toBe(result.manifest.bundle_hash);
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) expect(readFileSync(join(again, f)).equals(readFileSync(join(out, f))), f).toBe(true);
  });
});

describe("build-bundle refuses bad input", () => {
  function copyRun(): string {
    const d = join(tmp(), "run");
    cpSync(FIXTURE_RUN, d, { recursive: true });
    return d;
  }

  it("a pipeline-stage run (no core outputs) is refused with a pointer to Phase 2", () => {
    const d = copyRun();
    rmSync(join(d, "field_summary.jsonl"));
    expect(() => buildBundle(d, { out: tmp() })).toThrow(/not a published run.*field_summary\.jsonl/);
  });

  it("a response that breaks its schema fails the build before anything is written", () => {
    const d = copyRun();
    const story = read(join(d, "story.json"));
    (story["headline"] as Record<string, unknown>)["tag"] = "GUESSED";
    writeFileSync(join(d, "story.json"), JSON.stringify(story));
    const out = tmp();
    expect(() => buildBundle(d, { out })).toThrow(/\/api\/story/);
    expect(listFiles(out)).toEqual([]);
  });

  it("a real (non-fixture) run gets fixture:false on every response and updated_at from provenance", () => {
    const d = copyRun();
    for (const f of ["aoi.json", "passes.json", "story.json", "detectability.json", "states.json", "checks.json", "district_check.json", "provenance.json"]) {
      const doc = read(join(d, f));
      delete doc["fixture"];
      writeFileSync(join(d, f), JSON.stringify(doc));
    }
    const out = tmp();
    const r = buildBundle(d, { out });
    expect(r.live.fixture).toBe(false);
    expect(r.live.updated_at).toBe("2026-11-14T00:00:00Z");
    for (const name of ["meta", "story", "passes", "detectability", "states", "checks", "provenance"]) {
      expect(read(join(out, "runs", "fixture", "api", `${name}.json`))["fixture"], name).toBe(false);
    }
  });
});
