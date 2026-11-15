/**
 * Golden tests: core reproduces every rule output in contracts/fixtures exactly (CONTRACTS.md C0
 * "Cross-language equality", DECISIONS.md D-007). The fixtures were written by contracts/rules.py, so a pass
 * here means Python and TypeScript agree to the bit.
 */
import { describe, expect, it } from "vitest";
import type {
  Aoi,
  AuditRequest,
  AuditResponse,
  Detectability,
  FieldCollection,
  FieldSummaryLine,
  ObservationLine,
  Passes,
  States,
  Story,
} from "../src/contracts.gen.ts";
import {
  computeRun,
  DEFAULT_N_SIM,
  DEFAULT_PARAMS,
  DEFAULT_PARAM_SOURCES,
  DEFAULT_SEED,
  detectability,
  fieldSummary,
  rank,
  readAuditBody,
  sha256Hex,
  states,
  story,
  validateAuditRequest,
} from "../src/index.ts";
import { assertSameJson, firstDifference, fixtureBytes, fixtureJson, fixtureJsonl } from "./helpers.ts";

const aoi = fixtureJson<Aoi>("run/aoi.json");
const fields = fixtureJson<FieldCollection>("run/fields.geojson");
const passes = fixtureJson<Passes>("run/passes.json").passes;
const observations = fixtureJsonl<ObservationLine>("run/observations.jsonl");
const det = fixtureJson<Detectability>("run/detectability.json");
const summaryLines = fixtureJsonl<FieldSummaryLine>("run/field_summary.jsonl");
const passById = new Map(passes.map((p) => [p.pass_id, p] as const));

describe("helpers: the golden comparison itself", () => {
  it("compares numbers by value and reports the path of a difference", () => {
    expect(firstDifference({ a: [1, 2.5e-5] }, JSON.parse('{"a": [1.0, 2.5e-05]}'))).toBeNull();
    expect(firstDifference({ a: [1, 0.30000000000000004] }, { a: [1, 0.3] })).toBe("$.a[1]: 0.30000000000000004 !== 0.3");
    expect(firstDifference({ a: 1 }, { a: 1, b: null })).toMatch(/keys/);
    expect(firstDifference({ a: "1" }, { a: 1 })).toMatch(/expected number/);
  });
});

describe("parameters", () => {
  it("DEFAULT_PARAMS, DEFAULT_PARAM_SOURCES, seed and n_sim equal contracts/make_fixtures.py", () => {
    assertSameJson(DEFAULT_PARAMS, det.params, "params");
    assertSameJson(DEFAULT_PARAM_SOURCES, det.param_sources, "param_sources");
    expect(DEFAULT_SEED).toBe(det.seed);
    expect(DEFAULT_N_SIM).toBe(det.n_sim);
    expect(DEFAULT_PARAM_SOURCES.drained_fraction_of_cycle.status).toBe("needs_citation");
  });
});

describe("detectability.json", () => {
  it("reproduces pass_dates, every result and the sentence", () => {
    const out = detectability(passes, det.params, det.n_sim, det.seed);
    assertSameJson(out.pass_dates, det.pass_dates, "pass_dates");
    assertSameJson(out.results, det.results, "results");
    expect(out.sentence).toBe(det.sentence);
  });
});

describe("field_summary.jsonl", () => {
  it("reproduces all 300 lines exactly", () => {
    expect(summaryLines).toHaveLength(300);
    const byField = new Map<string, ObservationLine[]>();
    for (const o of observations) byField.set(o.field_id, [...(byField.get(o.field_id) ?? []), o]);
    let checked = 0;
    for (const expected of summaryLines) {
      const got = fieldSummary(
        expected.field_id,
        byField.get(expected.field_id) ?? [],
        passById,
        det.params,
        aoi.stages,
        det.n_sim,
        det.seed,
        expected.run_id,
        expected.fixture,
      );
      assertSameJson(got, expected, expected.field_id);
      checked += 1;
    }
    expect(checked).toBe(300);
    // all three verdicts and signals are exercised (SPEC B9)
    expect(new Set(summaryLines.map((s) => s.awd.verdict)).size).toBe(3);
    expect(new Set(summaryLines.map((s) => s.dsr.signal)).size).toBe(3);
  });
});

describe("states.json and story.json", () => {
  it("reproduces states.json", () => {
    const expected = fixtureJson<States>("run/states.json");
    const ids = fields.features.map((f) => f.properties.field_id);
    assertSameJson(states(ids, passes, observations, "fixture", true), expected);
  });

  it("reproduces story.json", () => {
    const expected = fixtureJson<Story>("run/story.json");
    const byId = new Map(summaryLines.map((s) => [s.field_id, s] as const));
    const used = passes.filter((p) => p.used).length;
    const got = story(aoi, fields.features.map((f) => f.properties), byId, used, "fixture", true);
    assertSameJson(got, expected);
  });
});

describe("api/audit.response.json", () => {
  it("is reproduced from the exact bytes of api/audit.request.json", async () => {
    const body = fixtureBytes("api/audit.request.json");
    const expected = fixtureJson<AuditResponse>("api/audit.response.json");
    const { request, inputHash } = await readAuditBody(body);
    const summaries = new Map(summaryLines.map((s) => [s.field_id, s] as const));
    const got = await rank(
      validateAuditRequest(request),
      inputHash,
      fields.features,
      summaries,
      expected.run_id,
      expected.created_at,
      expected.fixture,
    );
    assertSameJson(got, expected);
    expect(inputHash).toBe(await sha256Hex(body));
    expect(got.ranked.filter((r) => r.pick === "random")).toHaveLength(Math.floor((got.ranked.length + 2) / 5));
  });

  it("the ranking depends on the parsed request, not on its bytes (only the ids do)", async () => {
    const request = fixtureJson<AuditRequest>("api/audit.request.json");
    const expected = fixtureJson<AuditResponse>("api/audit.response.json");
    const compact = JSON.stringify(request);
    const { inputHash } = await readAuditBody(compact);
    const summaries = new Map(summaryLines.map((s) => [s.field_id, s] as const));
    const got = await rank(request, inputHash, fields.features, summaries, "fixture", expected.created_at, true);
    assertSameJson(got.ranked, expected.ranked);
    expect(got.input_hash).not.toBe(expected.input_hash);
    expect(got.audit_id).not.toBe(expected.audit_id);
  });
});

describe("computeRun", () => {
  it("on the fixture inputs equals every fixture output", () => {
    const out = computeRun({ aoi, fields, passes, observations, runId: "fixture", fixture: true });
    assertSameJson(out.detectability, det, "detectability.json");
    assertSameJson(out.summaries, summaryLines, "field_summary.jsonl");
    assertSameJson(out.states, fixtureJson("run/states.json"), "states.json");
    assertSameJson(out.story, fixtureJson("run/story.json"), "story.json");
  });

  it("keeps the schema's key order in what it writes", () => {
    const out = computeRun({ aoi, fields, passes, observations, runId: "fixture", fixture: true });
    expect(Object.keys(out.detectability)).toEqual(Object.keys(det));
    expect(Object.keys(out.summaries[0]!)).toEqual(Object.keys(summaryLines[0]!));
    expect(Object.keys(out.summaries[0]!.awd)).toEqual(Object.keys(summaryLines[0]!.awd));
    expect(Object.keys(out.story)).toEqual(Object.keys(fixtureJson<object>("run/story.json")));
  });

  it("refuses params whose stage boundaries differ from aoi.stages", () => {
    const params = { ...DEFAULT_PARAMS, stage_boundaries: { mid_start: "2026-07-20", late_start: "2026-09-10" } };
    expect(() => computeRun({ aoi, fields, passes, observations, runId: "fixture", params })).toThrow(/stage_boundaries/);
  });

  it("omits fixture when not given (real runs)", () => {
    const out = computeRun({ aoi, fields, passes, observations, runId: "r01" });
    expect("fixture" in out.detectability).toBe(false);
    expect("fixture" in out.summaries[0]!).toBe(false);
    expect(out.story.run_id).toBe("r01");
  });
});
