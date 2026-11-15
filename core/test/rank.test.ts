/**
 * Geometry and ranking (T7): mirrors GeometryTests and RankTests in contracts/tests/test_rules.py, plus the
 * bbox prefilter, request validation and error codes.
 */
import { describe, expect, it } from "vitest";
import type { AuditResponse, FieldSummaryLine } from "../src/contracts.gen.ts";
import {
  bboxMayContain,
  bboxOf,
  checkRings,
  contains,
  GeometryError,
  mulberry32,
  rank,
  RankError,
  readAuditBody,
  representativePoint,
  sha256Hex,
  validateAuditRequest,
  type PolygonGeometry,
  type RankField,
  type RankSummary,
} from "../src/index.ts";

const L_SHAPE: PolygonGeometry = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]] };

describe("geometry", () => {
  it("a concave claim's point is inside it", () => {
    const [x, y] = representativePoint(L_SHAPE);
    expect(contains(L_SHAPE, x, y)).toBe(true);
    // the vertex average (22/6, 22/6) is outside; the scanline midpoint is what rules.py returns
    expect([x, y]).toEqual([0.5, 3.6666666666666665]);
  });

  it("a convex claim uses the vertex average", () => {
    expect(representativePoint({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] })).toEqual([1, 1]);
  });

  it("a point is itself (altitude ignored)", () => {
    expect(representativePoint({ type: "Point", coordinates: [74.1, 30.2, 180] })).toEqual([74.1, 30.2]);
  });

  it("the largest part of a MultiPolygon wins; the first wins ties", () => {
    const small = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    const big = [[[10, 10], [14, 10], [14, 14], [10, 14], [10, 10]]];
    const same = [[[20, 20], [24, 20], [24, 24], [20, 24], [20, 20]]];
    expect(representativePoint({ type: "MultiPolygon", coordinates: [small, big, same] })).toEqual([12, 12]);
  });

  it("open rings and short rings are rejected", () => {
    expect(() => representativePoint({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] })).toThrow(GeometryError);
    expect(() => checkRings({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] })).toThrow(GeometryError);
    expect(() => checkRings({ type: "LineString", coordinates: [] })).toThrow(GeometryError);
  });

  it("a degenerate ring has no interior point", () => {
    expect(() => representativePoint({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] })).toThrow(/no interior/);
  });

  it("a shared edge belongs to exactly one cell", () => {
    const left: PolygonGeometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    const right: PolygonGeometry = { type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] };
    expect(Number(contains(left, 1.0, 0.5)) + Number(contains(right, 1.0, 0.5))).toBe(1);
  });

  it("holes are outside", () => {
    const donut: PolygonGeometry = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
      ],
    };
    expect(contains(donut, 2, 2)).toBe(false);
    expect(contains(donut, 0.5, 2)).toBe(true);
  });

  it("the bbox prefilter never changes a containment result", () => {
    const rng = mulberry32(123);
    const shapes: PolygonGeometry[] = [L_SHAPE];
    for (let s = 0; s < 40; s++) {
      const cx = 74 + rng();
      const cy = 30 + rng();
      const ring: number[][] = [];
      const n = 3 + Math.floor(rng() * 8);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const r = 0.0005 + rng() * 0.002;
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      ring.push(ring[0]!);
      shapes.push({ type: "Polygon", coordinates: [ring] });
    }
    for (const g of shapes) {
      const box = bboxOf(g);
      const ring = g.coordinates[0]!;
      // random points around the shape, plus every vertex and edge midpoint (the hard cases)
      const pts: Array<[number, number]> = ring.map((p) => [p[0]!, p[1]!]);
      for (let i = 0; i + 1 < ring.length; i++) pts.push([(ring[i]![0]! + ring[i + 1]![0]!) / 2, (ring[i]![1]! + ring[i + 1]![1]!) / 2]);
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      for (let k = 0; k < 400; k++) pts.push([box[0] - w + rng() * 3 * w, box[1] - h + rng() * 3 * h]);
      for (const [x, y] of pts) {
        if (contains(g, x, y)) expect(bboxMayContain(box, x, y), `${x},${y}`).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ ranking

const square = (lon: number, lat: number, d = 0.001): PolygonGeometry => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]],
});

interface WorldField extends RankField {
  readonly properties: RankField["properties"] & { readonly lon: number; readonly lat: number; readonly tile: string };
}

function world(nPerDistrict = 20): { fields: WorldField[]; summaries: Map<string, RankSummary> } {
  const fields: WorldField[] = [];
  const summaries = new Map<string, RankSummary>();
  const verdicts = ["inconsistent", "not_enough_evidence", "consistent"] as const;
  const signals = ["transplant_signal", "unknown", "dsr_signal"] as const;
  ["Fazilka", "Sri Muktsar Sahib"].forEach((district, di) => {
    const tile = ["fazilka", "muktsar"][di]!;
    for (let i = 0; i < nPerDistrict; i++) {
      const fid = `${tile}-${String(i + 1).padStart(5, "0")}`;
      const lon = 74.0 + di + i * 0.01;
      const lat = 30.0;
      fields.push({ geometry: square(lon, lat), properties: { field_id: fid, tile, district, area_ha: 1 + (i % 4), lon: lon + 0.0005, lat: lat + 0.0005 } });
      summaries.set(fid, { awd: { verdict: verdicts[i % 3]!, clear_looks: 5, drained_hits: i % 3 }, dsr: { signal: signals[(i + 1) % 3]! } });
    }
  });
  return { fields, summaries };
}

type ClaimFeature = { type: "Feature"; geometry: unknown; properties: Record<string, unknown> };

function body(fields: WorldField[], budget: number, seed?: number, extra: ClaimFeature[] = [], claimed: string[] = ["awd"]): string {
  const feats: ClaimFeature[] = fields.map((f, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [f.properties.lon, f.properties.lat] },
    properties: { claim_id: `C${String(i).padStart(3, "0")}`, claimed: [...claimed], synthetic: true },
  }));
  const req: Record<string, unknown> = { claims: { type: "FeatureCollection", features: [...feats, ...extra] }, budget };
  if (seed !== undefined) req.seed = seed;
  return JSON.stringify(req);
}

const { fields: FIELDS, summaries: SUMMARIES } = world();

async function run(b: string, fields: ReadonlyArray<RankField> = FIELDS, summaries: Map<string, RankSummary> = SUMMARIES): Promise<AuditResponse> {
  const { request, inputHash } = await readAuditBody(b);
  return rank(validateAuditRequest(request), inputHash, fields, summaries, "t1", "2026-11-14T00:00:00Z", false);
}

async function rankError(b: string): Promise<RankError> {
  try {
    await run(b);
  } catch (err) {
    if (err instanceof RankError) return err;
    throw err;
  }
  throw new Error("expected a RankError");
}

describe("rank (T7)", () => {
  it("exactly 20% random picks, score picks first, ranks 1..n", async () => {
    for (const budget of [5, 10, 15, 20, 25, 40]) {
      const out = await run(body(FIELDS, budget, 1));
      const picks = out.ranked.map((r) => r.pick);
      expect(picks).toHaveLength(budget);
      expect(picks.filter((p) => p === "random").length * 5).toBe(budget);
      expect(picks).toEqual([...Array(budget - budget / 5).fill("score"), ...Array(budget / 5).fill("random")]);
      expect(out.ranked.map((r) => r.rank)).toEqual(Array.from({ length: budget }, (_, i) => i + 1));
    }
  });

  it("n_random = floor((n + 2) / 5) for every n", async () => {
    for (let budget = 1; budget <= 40; budget++) {
      const out = await run(body(FIELDS, budget, 2));
      expect(out.ranked.filter((r) => r.pick === "random")).toHaveLength(Math.floor((budget + 2) / 5));
    }
  });

  it("same seed gives the same output; the seed changes the random picks", async () => {
    const a = await run(body(FIELDS, 20, 11));
    expect(await run(body(FIELDS, 20, 11))).toEqual(a);
    const randoms = new Set<string>();
    for (let s = 0; s < 8; s++) {
      const out = await run(body(FIELDS, 20, s));
      randoms.add(out.ranked.filter((r) => r.pick === "random").map((r) => r.claim_id).join(","));
    }
    expect(randoms.size).toBeGreaterThan(1);
  });

  it("a missing seed comes from the input hash; seed 0 is a seed", async () => {
    const b = body(FIELDS, 10);
    const out = await run(b);
    expect(out.seed).toBe(parseInt((await sha256Hex(b)).slice(0, 8), 16));
    expect(out.input_hash).toBe(await sha256Hex(b));
    expect(await run(b)).toEqual(out);
    expect((await run(body(FIELDS, 10, 0))).seed).toBe(0);
    const viaNull = await rank({ ...JSON.parse(b), seed: null }, out.input_hash, FIELDS, SUMMARIES, "t1", "2026-11-14T00:00:00Z", false);
    expect(viaNull.seed).toBe(out.seed); // null means absent, as in the reference
  });

  it("audit_id = a_ + first 16 hex of sha256(run_id|input_hash|budget|seed)", async () => {
    const b = body(FIELDS, 10, 5);
    const out = await run(b);
    expect(out.audit_id).toBe("a_" + (await sha256Hex(`t1|${out.input_hash}|10|5`)).slice(0, 16));
    expect(out.audit_id).toMatch(/^a_[0-9a-f]{16}$/);
  });

  it("score order and weights", async () => {
    const out = await run(body(FIELDS, 40, 3));
    const score = out.ranked.filter((r) => r.pick === "score");
    expect(score.map((r) => r.score)).toEqual([...score.map((r) => r.score)].sort((a, b) => b - a));
    expect(score[0]!.weight).toBe(1.0);
    expect(score[0]!.reason.startsWith("Not consistent with AWD (")).toBe(true);
    expect(out.notice).toBe("Ranking for inspection, not a finding about anyone.");
    expect(out.ranked.filter((r) => r.pick === "random").every((r) => r.reason.startsWith("Random check; "))).toBe(true);
  });

  it("random picks are stratified by district", async () => {
    for (let seed = 0; seed < 5; seed++) {
      const out = await run(body(FIELDS, 20, seed)); // 16 by score, 4 random from the other 24
      const picked = new Set(out.ranked.filter((r) => r.pick === "score").map((r) => r.claim_id));
      const remaining = FIELDS.filter((_, i) => !picked.has(`C${String(i).padStart(3, "0")}`));
      const randoms = out.ranked.filter((r) => r.pick === "random").map((r) => r.district);
      for (const district of ["Fazilka", "Sri Muktsar Sahib"]) {
        const share = remaining.filter((f) => f.properties.district === district).length / remaining.length;
        expect(Math.abs(randoms.filter((d) => d === district).length - 4 * share)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("unmatched claims, merged claims and DSR", async () => {
    const extra: ClaimFeature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [10.0, 10.0] }, properties: { claim_id: "U1", claimed: ["awd"], synthetic: true, area_ha: 2.5 } },
      { type: "Feature", geometry: FIELDS[0]!.geometry, properties: { claim_id: "DUP", claimed: ["dsr"], synthetic: false } },
    ];
    const out = await run(body(FIELDS.slice(0, 4), 10, 2, extra));
    expect([out.matched, out.unmatched]).toEqual([5, 1]);
    expect(out.synthetic).toBe(false);
    const byClaim = new Map(out.ranked.map((r) => [r.claim_id, r] as const));
    expect(byClaim.get("U1")!.field_id).toBeNull();
    expect(byClaim.get("U1")!.district).toBeNull();
    expect(byClaim.get("U1")!.score).toBe(0.8 * 2.5);
    expect(byClaim.get("U1")!.reason).toBe("Claim does not match a mapped rice field");
    const merged = byClaim.get("C000")!; // field 1 claimed for awd (C000) and dsr (DUP): one candidate, max weight
    expect(merged.reason).toContain("; DSR");
    expect(merged.reason).toBe("Not consistent with AWD (0 of 5 clear looks drained); DSR: signal unknown");
    expect(merged.weight).toBe(1.0);
    expect(byClaim.has("DUP")).toBe(false);
    expect(out.ranked).toHaveLength(5); // 4 fields + 1 unmatched; budget larger than candidates
  });

  it("an unmatched claim without a positive area scores 0.8", async () => {
    const extra: ClaimFeature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { claim_id: "Z", claimed: ["dsr"], synthetic: true, area_ha: 0 } },
    ];
    const out = await run(body([], 5, 1, extra));
    expect(out.ranked[0]!.score).toBe(0.8);
  });

  it("a concave field claim matches its field; a field without a summary weighs 0.6", async () => {
    const field: RankField = { geometry: L_SHAPE, properties: { field_id: "fazilka-00001", district: "Fazilka", area_ha: 2 } };
    const claim: ClaimFeature[] = [{ type: "Feature", geometry: L_SHAPE, properties: { claim_id: "L", claimed: ["awd"], synthetic: true } }];
    const { request, inputHash } = await readAuditBody(body([], 5, 1, claim));
    const out = await rank(validateAuditRequest(request), inputHash, [field], new Map(), "t", "2026-11-14T00:00:00Z", false);
    expect([out.matched, out.ranked[0]!.field_id]).toEqual([1, "fazilka-00001"]);
    expect(out.ranked[0]!.reason).toBe("No season summary yet");
    expect(out.ranked[0]!.weight).toBe(0.6);
    expect(out.ranked[0]!.score).toBe(0.6 * 2);
  });

  it("several containing fields: the smallest field_id wins", async () => {
    const big = square(0, 0, 10);
    const fields: RankField[] = [
      { geometry: big, properties: { field_id: "b-00002", district: "B", area_ha: 1 } },
      { geometry: big, properties: { field_id: "a-00009", district: "A", area_ha: 1 } },
    ];
    const claim: ClaimFeature[] = [{ type: "Feature", geometry: { type: "Point", coordinates: [5, 5] }, properties: { claimed: ["awd"], synthetic: true } }];
    const { request, inputHash } = await readAuditBody(body([], 5, 1, claim));
    const out = await rank(validateAuditRequest(request), inputHash, fields, new Map(), "t", "2026-11-14T00:00:00Z", false);
    expect(out.ranked[0]!.field_id).toBe("a-00009");
  });

  it("duplicate claim_id is rejected; a missing one becomes #n", async () => {
    const dup: ClaimFeature[] = Array(2).fill({ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { claim_id: "X", claimed: ["awd"], synthetic: true } });
    const err = await rankError(body([], 5, 1, dup));
    expect(err.code).toBe("duplicate_claim_id");
    expect(err.status).toBe(400);
    const anon: ClaimFeature[] = Array(2).fill({ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { claimed: ["awd"], synthetic: true } });
    const out = await run(body([], 5, 1, anon));
    expect(out.ranked.map((r) => r.claim_id).sort()).toEqual(["#1", "#2"]);
  });

  it("open rings are rejected as invalid_geometry", async () => {
    const bad: ClaimFeature[] = [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, properties: { claimed: ["awd"], synthetic: true } }];
    const err = await rankError(body([], 5, 1, bad));
    expect(err.code).toBe("invalid_geometry");
    expect(err.message).toContain("#1");
    // geometry errors win over duplicate ids, as in the reference (all geometry is checked first)
    const both: ClaimFeature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] }, properties: { claim_id: "A", claimed: ["awd"], synthetic: true } },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] }, properties: { claim_id: "A", claimed: ["awd"], synthetic: true } },
      bad[0]!,
    ];
    expect((await rankError(body([], 5, 1, both))).code).toBe("invalid_geometry");
  });

  it("the field_id hint wins over geometry", async () => {
    const hint: ClaimFeature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { claim_id: "H", claimed: ["awd"], synthetic: true, field_id: "muktsar-00003" } },
    ];
    expect((await run(body([], 5, 1, hint))).ranked[0]!.field_id).toBe("muktsar-00003");
    // an unknown hint falls back to geometry
    const stale: ClaimFeature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [FIELDS[2]!.properties.lon, FIELDS[2]!.properties.lat] }, properties: { claimed: ["awd"], synthetic: true, field_id: "fazilka-99999" } },
    ];
    expect((await run(body([], 5, 1, stale))).ranked[0]!.field_id).toBe(FIELDS[2]!.properties.field_id);
  });

  it("uses the summaries' DSR weights", async () => {
    const out = await run(body(FIELDS, 40, 1, [], ["dsr"]));
    for (const r of out.ranked) {
      const s = SUMMARIES.get(r.field_id!)!;
      expect(r.weight).toBe({ transplant_signal: 1, unknown: 0.6, dsr_signal: 0.1 }[s.dsr.signal]);
    }
  });

  it("accepts plain-object summaries (FieldSummaryLine records)", async () => {
    const rec: Record<string, FieldSummaryLine> = {};
    for (const [k, v] of SUMMARIES) rec[k] = v as FieldSummaryLine;
    const b = body(FIELDS, 20, 4);
    const { request, inputHash } = await readAuditBody(b);
    const viaRecord = await rank(validateAuditRequest(request), inputHash, FIELDS, rec, "t1", "2026-11-14T00:00:00Z", false);
    expect(viaRecord).toEqual(await run(b));
  });
});

describe("request handling", () => {
  it("readAuditBody: invalid JSON, invalid UTF-8, too large", async () => {
    await expect(readAuditBody("{nope")).rejects.toMatchObject({ code: "invalid_json", status: 400 });
    await expect(readAuditBody(new Uint8Array([0x7b, 0xff, 0x7d]))).rejects.toMatchObject({ code: "invalid_json" });
    await expect(readAuditBody("x".repeat(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "too_large", status: 413 });
  });

  it("validateAuditRequest follows api/audit_request.schema.json", () => {
    const ok = JSON.parse(body(FIELDS.slice(0, 2), 5, 1));
    expect(validateAuditRequest(ok)).toBe(ok);
    const bad = (patch: (r: any) => void): string => {
      const r = structuredClone(ok);
      patch(r);
      try {
        validateAuditRequest(r);
      } catch (err) {
        if (err instanceof RankError) return err.code;
        throw err;
      }
      return "ok";
    };
    expect(bad(() => {})).toBe("ok");
    expect(bad((r) => (r.budget = 0))).toBe("invalid_request");
    expect(bad((r) => (r.budget = 501))).toBe("invalid_request");
    expect(bad((r) => (r.budget = 2.5))).toBe("invalid_request");
    expect(bad((r) => (r.seed = -1))).toBe("invalid_request");
    expect(bad((r) => (r.seed = 4294967296))).toBe("invalid_request");
    expect(bad((r) => (r.extra = 1))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features = []))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features = Array(5001).fill(r.claims.features[0])))).toBe("too_many_claims");
    expect(bad((r) => (r.claims.features[0].properties.claimed = []))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].properties.claimed = ["awd", "awd"]))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].properties.claimed = ["cf"]))).toBe("invalid_request");
    expect(bad((r) => delete r.claims.features[0].properties.synthetic)).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].properties.claim_id = "has space"))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].properties.field_id = "Fazilka-1"))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].properties.area_ha = -1))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].geometry = { type: "LineString", coordinates: [[0, 0], [1, 1]] }))).toBe("invalid_request");
    expect(bad((r) => (r.claims.features[0].geometry.coordinates = [200, 0]))).toBe("invalid_request");
    // GIS exports: extra members, extra properties and altitude are accepted
    expect(bad((r) => ((r.claims.name = "export"), (r.claims.crs = {}), (r.claims.features[0].properties.owner_note = "x")))).toBe("ok");
    expect(bad((r) => (r.claims.features[0].geometry.coordinates = [74.1, 30.1, 210]))).toBe("ok");
  });
});
