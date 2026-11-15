// The static API bundle: equal to contracts/fixtures/api by parsed value, deterministic, refuses bad runs.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBundle } from "../../scripts/build-bundle.ts";
import { FIXTURE_RUN, REPO_ROOT, listFiles } from "../../scripts/lib/run.ts";
import { createSchemaAjv, validatorFor } from "../../scripts/lib/schemas.ts";
import { rank, readAuditBody, validateAuditRequest } from "@mudskipper/core";
import type { FieldFeature } from "../../src/contracts.ts";
import { decodeRankInput } from "../../src/repo/rank-input.ts";
import { fieldsPage } from "../../src/shapes.ts";

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

  it("the unfiltered page 1 is the fixture's GET /api/fields response, byte for byte what the API sends", () => {
    const text = readFileSync(join(run, "api", "pages", "_", "_", "1.json"), "utf8");
    expect(JSON.parse(text)).toStrictEqual(read(join(API, "fields.json")));
    expect(text).toBe(JSON.stringify(JSON.parse(text))); // pre-serialized: streamed as is
  });

  it("writes every page of every non-empty filter, each equal to the in-memory fieldsPage", () => {
    const rows = result.docs.fieldRows;
    const tiles = [null, "fazilka", "muktsar"];
    const verdicts = [null, "consistent", "inconsistent", "not_enough_evidence"];
    let files = 0;
    for (const tile of tiles) {
      for (const verdict of verdicts) {
        const want = fieldsPage("fixture", true, rows, { tile, verdict, page: 1 });
        const key = `${tile ?? "_"}/${verdict ?? "_"}`;
        expect(result.manifest.pages?.[key] ?? 0, key).toBe(want["total"]);
        if (want["total"] === 0) continue;
        expect(read(join(run, "api", "pages", tile ?? "_", verdict ?? "_", "1.json")), key).toStrictEqual(want);
        files++;
      }
    }
    expect(readdirSync(join(run, "api", "pages"), { recursive: true }).filter((f) => String(f).endsWith(".json"))).toHaveLength(files);
  });

  it("rank.bin decodes to an index that ranks exactly like core on fields.geojson", async () => {
    const bin = readFileSync(join(run, "api", "rank.bin"));
    const inputs = decodeRankInput(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), "fixture");
    const fc = read(join(FIXTURE_RUN, "fields.geojson")) as { features: FieldFeature[] };
    const sums = new Map(result.run.summaries!.map((s) => [s.field_id, s] as const));
    expect(inputs.index.size).toBe(300);
    expect(inputs.summaries.size).toBe(300);
    for (const f of fc.features) {
      expect(inputs.index.byId(f.properties.field_id)!.geometry).toStrictEqual(f.geometry);
      const s = inputs.summaries.get(f.properties.field_id)!;
      const want = sums.get(f.properties.field_id)!;
      expect(s).toStrictEqual({ awd: { verdict: want.awd.verdict, clear_looks: want.awd.clear_looks, drained_hits: want.awd.drained_hits }, dsr: { signal: want.dsr.signal } });
    }
    const body = readFileSync(join(API, "audit.request.json"));
    const { request, inputHash } = await readAuditBody(new Uint8Array(body));
    const req = validateAuditRequest(request);
    const viaBin = await rank(req, inputHash, inputs.index, inputs.summaries, "fixture", "2026-11-14T00:00:00Z", true);
    expect(viaBin).toStrictEqual(read(join(API, "audit.response.json")));
    expect(() => decodeRankInput(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), "r01")).toThrow(/run fixture/);
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

  it("a pipeline-stage run (no core outputs) is refused with a pointer to compute-run", () => {
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
