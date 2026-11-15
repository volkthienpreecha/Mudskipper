/**
 * The ranking input in one binary file (`/data/runs/<id>/api/rank.bin`), written by the bundle builder and
 * read by POST /api/audit on the static backend, so a cold isolate never parses the 3.8 MB fields.geojson
 * (about 25 ms of CPU on its own, over the free plan's 10 ms).
 *
 * Layout (little-endian): "MSKR", u32 version (2), u32 header length, the header as UTF-8 JSON, zero padding to
 * a multiple of 8, then the typed sections the header names by [byte offset, element count]:
 *
 *   bbox    Float64[4n]   bboxOf(geometry) per field (core/geometry.ts), so the grid needs no pass over vertices
 *   coords  Float64[2V]   lon, lat of every position (altitude is never read by ranking)
 *   area    Float64[n]    properties.area_ha
 *   parts   Uint32[n+1]   field k owns polygons parts[k] .. parts[k+1]
 *   rings   Uint32[P+1]   polygon p owns rings rings[p] .. rings[p+1] (outer ring first)
 *   verts   Uint32[R+1]   ring r owns positions verts[r] .. verts[r+1]
 *   district Uint32[n]    index into the header's `districts`
 *   clear, drained Uint32[n]   the summary's awd.clear_looks and awd.drained_hits (0 without a summary)
 *   gridStart, gridItems Uint32   core's fieldIndex grid over these boxes (its `.grid`; scalars in the header)
 *
 * The header carries the field ids (sorted), the district names, and one character per field for the geometry
 * type and the summary's verdict and DSR signal ("-" where a field has no summary). Version 2 (DECISIONS.md
 * K-352) moved every per-field number out of the JSON header into typed sections, and decoding builds no
 * per-field objects: the sections are views on the buffer, ranking reads them through core's
 * `columnarFieldIndex` (point-in-polygon on the typed arrays, `containsFlat`), and a field object is made
 * only for a field a claim matches. Float64 keeps every coordinate's and area's exact double, so containment
 * and scores are bit-for-bit the GeoJSON's (tests compare whole rankings against core on the parsed fields).
 */
import {
  bboxOf,
  columnarFieldIndex,
  fieldIndex,
  type BBox,
  type FieldColumns,
  type FieldGrid,
  type FieldIndex,
  type RankField,
  type RankSummary,
} from "@mudskipper/core";
import type { DsrSignal, FieldFeature, FieldSummary, Verdict } from "../contracts.ts";

const MAGIC = 0x524b534d; // "MSKR" read as a little-endian u32
const VERSION = 2;
const VERDICT_CODE: Record<Verdict, string> = { consistent: "c", inconsistent: "i", not_enough_evidence: "n" };
const DSR_CODE: Record<DsrSignal, string> = { transplant_signal: "t", unknown: "u", dsr_signal: "d" };
const VERDICT_OF: Record<string, Verdict> = { c: "consistent", i: "inconsistent", n: "not_enough_evidence" };
const DSR_OF: Record<string, DsrSignal> = { t: "transplant_signal", u: "unknown", d: "dsr_signal" };

interface Header {
  v: 2;
  run_id: string;
  n: number;
  ids: string[];
  districts: string[];
  /** "P" (Polygon) or "M" (MultiPolygon) per field. */
  types: string;
  /** Per field: verdict code, or "-" without a summary. */
  verdicts: string;
  /** Per field: DSR code, or "-" without a summary. */
  dsr: string;
  grid: Pick<FieldGrid, "x0" | "y0" | "x1" | "y1" | "size" | "nx" | "ny">;
  sections: Record<SectionName, [number, number]>;
}

type SectionName = "bbox" | "coords" | "area" | "parts" | "rings" | "verts" | "district" | "clear" | "drained" | "gridStart" | "gridItems";

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A count stored in a Uint32 section: anything else would not round-trip, so the bundle build stops. */
function count(v: number, what: string): number {
  if (!(Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) throw new RangeError(`rank.bin: ${what} ${v} is not a uint32`);
  return v;
}

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
  const clear: number[] = [];
  const drained: number[] = [];
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
    clear.push(s ? count(s.awd.clear_looks, "clear_looks") : 0);
    drained.push(s ? count(s.awd.drained_hits, "drained_hits") : 0);
  }
  const boxes: BBox[] = [];
  for (let k = 0; k < fields.length; k++) boxes.push([bbox[4 * k]!, bbox[4 * k + 1]!, bbox[4 * k + 2]!, bbox[4 * k + 3]!]);
  const { start, items, ...gridScalars } = fieldIndex(fields as unknown as RankField[], { boxes }).grid;
  const arrays: [SectionName, Float64Array | Uint32Array][] = [
    ["bbox", Float64Array.from(bbox)],
    ["coords", Float64Array.from(coords)],
    ["area", Float64Array.from(fields, (f) => f.properties.area_ha)],
    ["parts", Uint32Array.from(parts)],
    ["rings", Uint32Array.from(rings)],
    ["verts", Uint32Array.from(verts)],
    ["district", Uint32Array.from(fields, (f) => districts.indexOf(f.properties.district))],
    ["clear", Uint32Array.from(clear)],
    ["drained", Uint32Array.from(drained)],
    ["gridStart", start],
    ["gridItems", items],
  ];
  const sections = Object.fromEntries(arrays.map(([name]) => [name, [0, 0]])) as Header["sections"];
  const header: Header = {
    v: 2,
    run_id: runId,
    n: fields.length,
    ids: fields.map((f) => f.properties.field_id),
    districts,
    types,
    verdicts,
    dsr,
    grid: gridScalars,
    sections,
  };
  // Offsets depend on the header length, which depends on the offsets' digits: settle them in a few passes.
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

type AreaGeometry = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

interface Columns {
  h: Header;
  types: string;
  coords: Float64Array;
  parts: Uint32Array;
  rings: Uint32Array;
  verts: Uint32Array;
  area: Float64Array;
  district: Uint32Array;
  clear: Uint32Array;
  drained: Uint32Array;
}

/** One field as ranking reads it; made only when a lookup returns it. Its geometry is built on first access. */
class LazyField implements RankField {
  readonly properties: { field_id: string; district: string; area_ha: number };
  readonly k: number;
  private readonly src: Columns;
  private g: AreaGeometry | undefined;

  constructor(k: number, src: Columns) {
    this.k = k;
    this.src = src;
    this.properties = { field_id: src.h.ids[k]!, district: src.h.districts[src.district[k]!]!, area_ha: src.area[k]! };
  }

  /** Not read by ranking (containment uses the typed arrays); kept so a field is still a RankField. */
  get geometry(): AreaGeometry {
    return (this.g ??= geometryOf(this.src, this.k));
  }
}

function geometryOf(s: Columns, k: number): AreaGeometry {
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

/** A field_id → summary view over the summary columns; a summary object is built on first access. */
class SummaryView extends Map<string, RankSummary> {
  private readonly index: FieldIndex<RankField>;
  private readonly src: Columns;

  constructor(index: FieldIndex<RankField>, src: Columns) {
    super();
    this.index = index;
    this.src = src;
  }
  override get(id: string): RankSummary | undefined {
    const hit = super.get(id);
    if (hit) return hit;
    const f = this.index.byId(id) as LazyField | undefined;
    const h = this.src.h;
    if (f === undefined || h.verdicts[f.k] === "-") return undefined;
    const k = f.k;
    const s: RankSummary = {
      awd: { verdict: VERDICT_OF[h.verdicts[k]!]!, clear_looks: this.src.clear[k]!, drained_hits: this.src.drained[k]! },
      dsr: { signal: DSR_OF[h.dsr[k]!]! },
    };
    super.set(id, s);
    return s;
  }
  override has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  override get size(): number {
    let n = 0;
    for (const c of this.src.h.verdicts) if (c !== "-") n++;
    return n;
  }
}

/** Map rank.bin onto core's columnar field index and a summary lookup (no per-field work up front). */
export function decodeRankInput(buf: ArrayBuffer, expectRunId: string): RankInputs {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) {
    throw new Error(`rank.bin: not a version-${VERSION} ranking input`);
  }
  const len = dv.getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len))) as Header;
  if (h.run_id !== expectRunId) throw new Error(`rank.bin is for run ${h.run_id}, not ${expectRunId}`);
  const f64 = (name: SectionName) => new Float64Array(buf, h.sections[name][0], h.sections[name][1]);
  const u32 = (name: SectionName) => new Uint32Array(buf, h.sections[name][0], h.sections[name][1]);
  const src: Columns = {
    h,
    types: h.types,
    coords: f64("coords"),
    parts: u32("parts"),
    rings: u32("rings"),
    verts: u32("verts"),
    area: f64("area"),
    district: u32("district"),
    clear: u32("clear"),
    drained: u32("drained"),
  };
  if (h.ids.length !== h.n || src.area.length !== h.n) throw new Error("rank.bin: sections do not match the field count");
  const made: (LazyField | undefined)[] = new Array(h.n);
  const cols: FieldColumns<LazyField> = {
    ids: h.ids,
    boxes: f64("bbox"),
    parts: src.parts,
    rings: src.rings,
    verts: src.verts,
    coords: src.coords,
    grid: { ...h.grid, start: u32("gridStart"), items: u32("gridItems") },
    field: (k) => (made[k] ??= new LazyField(k, src)),
  };
  const index = columnarFieldIndex<RankField>(cols);
  return { index, summaries: new SummaryView(index, src) };
}
