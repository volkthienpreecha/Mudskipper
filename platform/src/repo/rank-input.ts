/**
 * The ranking input in one binary file (`/data/runs/<id>/api/rank.bin`), written by the bundle builder and
 * read by POST /api/audit on the static backend, so a cold isolate never parses the 3.8 MB fields.geojson
 * (about 25 ms of CPU on its own, over the free plan's 10 ms).
 *
 * Layout (little-endian): "MSKR", u32 version (1), u32 header length, the header as UTF-8 JSON, zero padding to
 * a multiple of 8, then the typed sections the header names by [byte offset, element count]:
 *
 *   bbox   Float64[4n]   bboxOf(geometry) per field (core/geometry.ts), so the grid needs no pass over vertices
 *   parts  Uint32[n+1]   field k owns polygons parts[k] .. parts[k+1]
 *   rings  Uint32[P+1]   polygon p owns rings rings[p] .. rings[p+1] (outer ring first)
 *   verts  Uint32[R+1]   ring r owns positions verts[r] .. verts[r+1]
 *   coords Float64[2V]   lon, lat of every position (altitude is never read by ranking)
 *   gridStart, gridItems Uint32   core's fieldIndex grid over these boxes (its `.grid`; scalars in the header)
 *
 * The header carries what ranking reads besides geometry: field ids (sorted), district, area_ha and the
 * summary columns (verdict, clear_looks, drained_hits, DSR signal), with `null` where a field has no summary.
 * Float64 keeps every coordinate's exact double, so containment is bit-for-bit the GeoJSON's (tests compare
 * whole rankings against core on the parsed fields). Geometry objects are built only for fields a claim's
 * point falls in the box of, and kept for the isolate's lifetime.
 */
import { bboxOf, fieldIndex, type BBox, type FieldGrid, type FieldIndex, type RankField, type RankSummary } from "@mudskipper/core";
import type { DsrSignal, FieldFeature, FieldSummary, Verdict } from "../contracts.ts";

const MAGIC = 0x524b534d; // "MSKR" read as a little-endian u32
const VERSION = 1;
const VERDICT_CODE: Record<Verdict, string> = { consistent: "c", inconsistent: "i", not_enough_evidence: "n" };
const DSR_CODE: Record<DsrSignal, string> = { transplant_signal: "t", unknown: "u", dsr_signal: "d" };
const VERDICT_OF: Record<string, Verdict> = { c: "consistent", i: "inconsistent", n: "not_enough_evidence" };
const DSR_OF: Record<string, DsrSignal> = { t: "transplant_signal", u: "unknown", d: "dsr_signal" };

interface Header {
  v: 1;
  run_id: string;
  n: number;
  ids: string[];
  districts: string[];
  district: number[];
  area: number[];
  /** "P" (Polygon) or "M" (MultiPolygon) per field. */
  types: string;
  /** Per field: verdict code, or "-" without a summary. */
  verdicts: string;
  /** Per field: DSR code, or "-" without a summary. */
  dsr: string;
  clear: (number | null)[];
  drained: (number | null)[];
  grid: Pick<FieldGrid, "x0" | "y0" | "x1" | "y1" | "size" | "nx" | "ny">;
  sections: Record<SectionName, [number, number]>;
}

type SectionName = "bbox" | "parts" | "rings" | "verts" | "coords" | "gridStart" | "gridItems";

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Encode a run's fields and summaries (bundle time). Deterministic for the same input. */
export function encodeRankInput(runId: string, features: ReadonlyArray<FieldFeature>, summaries: ReadonlyArray<FieldSummary>): Uint8Array<ArrayBuffer> {
  const fields = [...features].sort((a, b) => byCodeUnits(a.properties.field_id, b.properties.field_id));
  const sums = new Map(summaries.map((s) => [s.field_id, s] as const));
  const districts = [...new Set(fields.map((f) => f.properties.district))].sort(byCodeUnits);
  const parts: number[] = [0];
  const rings: number[] = [0];
  const verts: number[] = [0];
  const coords: number[] = [];
  const bbox: number[] = [];
  let types = "";
  let verdicts = "";
  let dsr = "";
  for (const f of fields) {
    const g = f.geometry as { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
    types += g.type === "Polygon" ? "P" : "M";
    for (const poly of polys) {
      for (const ring of poly) {
        for (const p of ring) coords.push(p[0]!, p[1]!);
        verts.push(coords.length / 2);
      }
      rings.push(verts.length - 1);
    }
    parts.push(rings.length - 1);
    bbox.push(...bboxOf(f.geometry as never));
    const s = sums.get(f.properties.field_id);
    verdicts += s ? VERDICT_CODE[s.awd.verdict] : "-";
    dsr += s ? DSR_CODE[s.dsr.signal] : "-";
  }
  const boxes: BBox[] = [];
  for (let k = 0; k < fields.length; k++) boxes.push([bbox[4 * k]!, bbox[4 * k + 1]!, bbox[4 * k + 2]!, bbox[4 * k + 3]!]);
  const { start, items, ...gridScalars } = fieldIndex(fields as unknown as RankField[], { boxes }).grid;
  const sections: Header["sections"] = { bbox: [0, 0], parts: [0, 0], rings: [0, 0], verts: [0, 0], coords: [0, 0], gridStart: [0, 0], gridItems: [0, 0] };
  const arrays: [SectionName, Float64Array | Uint32Array][] = [
    ["bbox", Float64Array.from(bbox)],
    ["coords", Float64Array.from(coords)],
    ["parts", Uint32Array.from(parts)],
    ["rings", Uint32Array.from(rings)],
    ["verts", Uint32Array.from(verts)],
    ["gridStart", start],
    ["gridItems", items],
  ];
  const header: Header = {
    v: 1,
    run_id: runId,
    n: fields.length,
    ids: fields.map((f) => f.properties.field_id),
    districts,
    district: fields.map((f) => districts.indexOf(f.properties.district)),
    area: fields.map((f) => f.properties.area_ha),
    types,
    verdicts,
    dsr,
    clear: fields.map((f) => sums.get(f.properties.field_id)?.awd.clear_looks ?? null),
    drained: fields.map((f) => sums.get(f.properties.field_id)?.awd.drained_hits ?? null),
    grid: gridScalars,
    sections,
  };
  // Offsets depend on the header length, which depends on the offsets' digits: settle them in two passes.
  let headerBytes = new Uint8Array(0);
  for (let pass = 0; pass < 3; pass++) {
    let off = align8(12 + headerBytes.byteLength);
    for (const [name, arr] of arrays) {
      sections[name] = [off, arr.length];
      off = align8(off + arr.byteLength);
    }
    headerBytes = new TextEncoder().encode(JSON.stringify(header));
  }
  let total = align8(12 + headerBytes.byteLength);
  for (const [, arr] of arrays) total = align8(total + arr.byteLength);
  const out = new Uint8Array(new ArrayBuffer(total));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, headerBytes.byteLength, true);
  out.set(headerBytes, 12);
  if (align8(12 + headerBytes.byteLength) !== sections.bbox[0]) throw new Error("rank.bin: header offsets did not settle");
  for (const [name, arr] of arrays) out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), sections[name][0]);
  return out;
}

const align8 = (n: number) => (n + 7) & ~7;

export interface RankInputs {
  index: FieldIndex<RankField>;
  summaries: ReadonlyMap<string, RankSummary>;
}

/** One field as ranking reads it; its geometry is built from the typed sections on first access, then kept. */
class LazyField implements RankField {
  readonly properties: { field_id: string; district: string; area_ha: number };
  readonly k: number;
  private readonly src: Sections;
  private g: AreaGeometry | undefined;

  constructor(k: number, properties: LazyField["properties"], src: Sections) {
    this.k = k;
    this.properties = properties;
    this.src = src;
  }

  get geometry(): AreaGeometry {
    return (this.g ??= geometryOf(this.src, this.k));
  }
}

type AreaGeometry = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

interface Sections {
  types: string;
  coords: Float64Array;
  parts: Uint32Array;
  rings: Uint32Array;
  verts: Uint32Array;
}

function geometryOf(s: Sections, k: number): AreaGeometry {
  const polys: number[][][][] = [];
  for (let p = s.parts[k]!; p < s.parts[k + 1]!; p++) {
    const poly: number[][][] = [];
    for (let r = s.rings[p]!; r < s.rings[p + 1]!; r++) {
      const ring: number[][] = [];
      for (let v = s.verts[r]!; v < s.verts[r + 1]!; v++) ring.push([s.coords[2 * v]!, s.coords[2 * v + 1]!]);
      poly.push(ring);
    }
    polys.push(poly);
  }
  return s.types[k] === "P" ? { type: "Polygon", coordinates: polys[0]! } : { type: "MultiPolygon", coordinates: polys };
}

/** A field_id → summary view over the header columns; a summary object is built on first access. */
class SummaryView extends Map<string, RankSummary> {
  private readonly index: FieldIndex<RankField>;
  private readonly h: Header;

  constructor(index: FieldIndex<RankField>, h: Header) {
    super();
    this.index = index;
    this.h = h;
  }
  override get(id: string): RankSummary | undefined {
    const hit = super.get(id);
    if (hit) return hit;
    const f = this.index.byId(id) as LazyField | undefined;
    if (f === undefined || this.h.verdicts[f.k] === "-") return undefined;
    const k = f.k;
    const s: RankSummary = {
      awd: { verdict: VERDICT_OF[this.h.verdicts[k]!]!, clear_looks: this.h.clear[k]!, drained_hits: this.h.drained[k]! },
      dsr: { signal: DSR_OF[this.h.dsr[k]!]! },
    };
    super.set(id, s);
    return s;
  }
  override has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  override get size(): number {
    let n = 0;
    for (const c of this.h.verdicts) if (c !== "-") n++;
    return n;
  }
}

/** Decode rank.bin into a prebuilt spatial index (core's fieldIndex) and a summary lookup. */
export function decodeRankInput(buf: ArrayBuffer, expectRunId: string): RankInputs {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) {
    throw new Error("rank.bin: not a version-1 ranking input");
  }
  const len = dv.getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len))) as Header;
  if (h.run_id !== expectRunId) throw new Error(`rank.bin is for run ${h.run_id}, not ${expectRunId}`);
  const f64 = (name: SectionName) => new Float64Array(buf, h.sections[name][0], h.sections[name][1]);
  const u32 = (name: SectionName) => new Uint32Array(buf, h.sections[name][0], h.sections[name][1]);
  const bbox = f64("bbox");
  const src: Sections = { types: h.types, coords: f64("coords"), parts: u32("parts"), rings: u32("rings"), verts: u32("verts") };
  const fields: LazyField[] = new Array(h.n);
  const boxes: BBox[] = new Array(h.n);
  for (let k = 0; k < h.n; k++) {
    fields[k] = new LazyField(k, { field_id: h.ids[k]!, district: h.districts[h.district[k]!]!, area_ha: h.area[k]! }, src);
    boxes[k] = [bbox[4 * k]!, bbox[4 * k + 1]!, bbox[4 * k + 2]!, bbox[4 * k + 3]!];
  }
  const index = fieldIndex<RankField>(fields, { boxes, grid: { ...h.grid, start: u32("gridStart"), items: u32("gridItems") } });
  return { index, summaries: new SummaryView(index, h) };
}
