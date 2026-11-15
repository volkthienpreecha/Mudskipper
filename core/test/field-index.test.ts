/**
 * The spatial index returns exactly what B6 step 1's linear scan returns (smallest field_id containing the
 * point), for points inside, outside, on edges and on vertices, whatever the cell size; and rank() gives the
 * same output with a prebuilt index as with the plain list.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FieldCollection } from "../src/contracts.gen.ts";
import { bboxOf, contains, fieldIndex, mulberry32, rank, readAuditBody, ringsOf, validateAuditRequest } from "../src/index.ts";
import type { AreaGeometryInput, RankField } from "../src/index.ts";

const RUN = new URL("../../contracts/fixtures/run/", import.meta.url);
const FIELDS = (JSON.parse(readFileSync(new URL("fields.geojson", RUN), "utf8")) as FieldCollection).features as unknown as RankField[];

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function scan(fields: ReadonlyArray<RankField>, x: number, y: number): string | undefined {
  return [...fields].sort((a, b) => byCodeUnits(a.properties.field_id, b.properties.field_id)).find((f) => contains(f.geometry, x, y))?.properties.field_id;
}

function probes(fields: ReadonlyArray<RankField>, n: number, seed: number): [number, number][] {
  const rng = mulberry32(seed);
  const pts: [number, number][] = [];
  for (const f of fields) {
    const [x0, y0, x1, y1] = bboxOf(f.geometry);
    for (const ring of ringsOf(f.geometry).flat()) for (const p of ring.slice(0, 3)) pts.push([p[0]!, p[1]!]); // vertices
    const p = ringsOf(f.geometry)[0]![0]!;
    pts.push([(p[0]![0]! + p[1]![0]!) / 2, (p[0]![1]! + p[1]![1]!) / 2]); // an edge midpoint
    pts.push([x0, y0], [x1, y1], [x0 + (x1 - x0) * rng(), y0 + (y1 - y0) * rng()]);
  }
  const all = fields.map((f) => bboxOf(f.geometry));
  const X0 = Math.min(...all.map((b) => b[0])) - 0.01;
  const X1 = Math.max(...all.map((b) => b[2])) + 0.01;
  const Y0 = Math.min(...all.map((b) => b[1])) - 0.01;
  const Y1 = Math.max(...all.map((b) => b[3])) + 0.01;
  for (let i = 0; i < n; i++) pts.push([X0 + (X1 - X0) * rng(), Y0 + (Y1 - Y0) * rng()]);
  return pts;
}

describe("fieldIndex", () => {
  it.each([undefined, 1e-4, 0.003, 0.05, 10])("matches the linear scan on the fixture fields (cell %s deg)", (cellDeg) => {
    const index = fieldIndex(FIELDS, cellDeg === undefined ? {} : { cellDeg });
    for (const [x, y] of probes(FIELDS, 3000, 7)) expect(index.locate(x, y)?.properties.field_id, `${x},${y}`).toBe(scan(FIELDS, x, y));
  });

  it("overlapping fields: the smallest field_id wins; repeated ids: the last one is the hint target", () => {
    const sq = (x: number, y: number, d: number): AreaGeometryInput => ({ type: "Polygon", coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
    const fields: RankField[] = [
      { geometry: sq(0, 0, 10), properties: { field_id: "b-00002", district: "B", area_ha: 1 } },
      { geometry: sq(2, 2, 2), properties: { field_id: "a-00009", district: "A", area_ha: 1 } },
      { geometry: sq(5, 5, 1), properties: { field_id: "a-00001", district: "A", area_ha: 1 } },
      { geometry: sq(50, 50, 1), properties: { field_id: "a-00001", district: "A", area_ha: 2 } },
    ];
    const index = fieldIndex(fields);
    expect(index.locate(3, 3)?.properties.field_id).toBe("a-00009");
    expect(index.locate(9, 9)?.properties.field_id).toBe("b-00002");
    expect(index.locate(5.5, 5.5)?.properties.field_id).toBe("a-00001");
    expect(index.locate(-1, 3)).toBeUndefined();
    expect(index.byId("a-00001")?.properties.area_ha).toBe(2);
    for (const [x, y] of probes(fields, 2000, 3)) expect(index.locate(x, y)?.properties.field_id).toBe(scan(fields, x, y));
  });

  it("precomputed boxes give the same index; an empty run locates nothing", () => {
    const boxes = FIELDS.map((f) => bboxOf(f.geometry));
    const a = fieldIndex(FIELDS);
    const b = fieldIndex(FIELDS, { boxes });
    for (const [x, y] of probes(FIELDS, 500, 11)) expect(b.locate(x, y)).toBe(a.locate(x, y));
    expect(fieldIndex([]).locate(74, 30)).toBeUndefined();
    expect(() => fieldIndex(FIELDS, { boxes: boxes.slice(1) })).toThrow(RangeError);
  });

  it("a stored grid (index.grid) rebuilds the same index; a grid of other fields is refused", () => {
    const sortedFields = [...FIELDS].sort((a, b) => byCodeUnits(a.properties.field_id, b.properties.field_id));
    const a = fieldIndex(sortedFields);
    const copy = { ...a.grid, start: Uint32Array.from(a.grid.start), items: Uint32Array.from(a.grid.items) };
    const b = fieldIndex(sortedFields, { grid: copy });
    for (const [x, y] of probes(FIELDS, 1000, 13)) expect(b.locate(x, y)).toBe(a.locate(x, y));
    expect(() => fieldIndex(sortedFields.slice(0, 10), { grid: copy })).toThrow(RangeError);
    expect(() => fieldIndex([...sortedFields].reverse(), { grid: copy })).toThrow(RangeError);
  });

  it("rank() with a prebuilt index equals rank() with the list", async () => {
    const rng = mulberry32(5);
    const claims = Array.from({ length: 400 }, (_, i) => {
      const f = FIELDS[Math.floor(rng() * FIELDS.length)]!;
      const [x0, y0, x1, y1] = bboxOf(f.geometry);
      const pt = rng() < 0.2 ? [73.9 + rng(), 30 + rng() * 0.6] : [x0 + (x1 - x0) * rng(), y0 + (y1 - y0) * rng()];
      return { type: "Feature", geometry: rng() < 0.3 ? f.geometry : { type: "Point", coordinates: pt }, properties: { claim_id: `C${i}`, claimed: ["awd"], synthetic: true } };
    });
    const { request, inputHash } = await readAuditBody(JSON.stringify({ claims: { type: "FeatureCollection", features: claims }, budget: 200, seed: 3 }));
    const req = validateAuditRequest(request);
    const viaList = await rank(req, inputHash, FIELDS, new Map(), "fixture", "2026-11-14T00:00:00Z", true);
    const viaIndex = await rank(req, inputHash, fieldIndex(FIELDS), new Map(), "fixture", "2026-11-14T00:00:00Z", true);
    expect(viaIndex).toEqual(viaList);
    expect(viaList.matched).toBeGreaterThan(300);
  });
});
