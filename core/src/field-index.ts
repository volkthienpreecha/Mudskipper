/**
 * A uniform-grid spatial index for B6 ranking step 1 ("Implementations MAY skip fields whose bounding box
 * does not contain the point first"). `locate` returns exactly what the contract's linear scan returns: the
 * smallest `field_id` (UTF-16 code-unit order) whose polygon contains the point, or undefined.
 *
 * Why it is exact. A field is listed in every cell its padded box `[minX - pad, maxX + pad] × [minY, maxY]`
 * (the region where `bboxMayContain` can be true) touches. Cell numbers are `floor((v - origin) / size)`,
 * and IEEE subtraction, division by a positive number and floor are all monotone, so a point inside that box
 * always lands in one of those cells. Each cell keeps its fields in field_id order, so the first one that
 * passes `bboxMayContain` and `contains` is the first the linear scan would have found. A point outside the
 * grid lies outside every padded box, hence in no field.
 *
 * Built once per run (the Worker keeps it for the isolate's lifetime); a lookup touches a handful of fields
 * instead of all 4,600.
 */
import { bboxMayContain, bboxOf, contains, type AreaGeometryInput, type BBox } from "./geometry.ts";

/** What the index reads from a field (`fields.geojson` features and rank's `RankField` are assignable). */
export interface IndexedField {
  readonly geometry: AreaGeometryInput;
  readonly properties: { readonly field_id: string };
}

export interface FieldIndex<F extends IndexedField = IndexedField> {
  /** Number of fields. */
  readonly size: number;
  /** The field with this id, or undefined. */
  byId(fieldId: string): F | undefined;
  /** The smallest field_id whose polygon contains (px, py) (B6 step 1), or undefined. */
  locate(px: number, py: number): F | undefined;
}

export interface FieldIndexOptions {
  /** Bounding boxes (`bboxOf`) in the same order as `fields`, when the caller has them precomputed. */
  readonly boxes?: ReadonlyArray<BBox>;
  /** Grid cell size in degrees. Default: about one field per cell, at most 1,048,576 cells. */
  readonly cellDeg?: number;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const MAX_CELLS = 1 << 20;

/** The x padding `bboxMayContain` applies to `bbox`. */
function padOf(b: BBox): number {
  return 1e-9 * (Math.abs(b[0]) + Math.abs(b[2]) + 1);
}

export function isFieldIndex<F extends IndexedField>(x: ReadonlyArray<F> | FieldIndex<F>): x is FieldIndex<F> {
  return !Array.isArray(x) && typeof (x as FieldIndex<F>).locate === "function";
}

export function fieldIndex<F extends IndexedField>(fields: ReadonlyArray<F>, options: FieldIndexOptions = {}): FieldIndex<F> {
  if (options.boxes && options.boxes.length !== fields.length) throw new RangeError("boxes must have one entry per field");
  const order = fields.map((_, k) => k).sort((a, b) => byCodeUnits(fields[a]!.properties.field_id, fields[b]!.properties.field_id));
  const ordered = order.map((k) => fields[k]!);
  const boxes = order.map((k) => options.boxes?.[k] ?? bboxOf(fields[k]!.geometry));
  const byId = new Map<string, F>();
  for (const f of fields) byId.set(f.properties.field_id, f); // a repeated id: the last one wins, as in rules.rank

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    const pad = padOf(b);
    if (!(b[0] <= b[2] && b[1] <= b[3])) continue; // a field with no outer ring can contain nothing
    x0 = Math.min(x0, b[0] - pad);
    x1 = Math.max(x1, b[2] + pad);
    y0 = Math.min(y0, b[1]);
    y1 = Math.max(y1, b[3]);
  }
  const empty = !(x0 <= x1 && y0 <= y1);
  const w = empty ? 0 : x1 - x0;
  const h = empty ? 0 : y1 - y0;
  let size = options.cellDeg ?? Math.sqrt((w * h) / Math.max(1, ordered.length));
  if (!(size > 0) || !Number.isFinite(size)) size = Math.max(w, h, 1e-6);
  while (Math.ceil(w / size + 1) * Math.ceil(h / size + 1) > MAX_CELLS) size *= 2;
  const nx = empty ? 0 : Math.floor(w / size) + 1;
  const ny = empty ? 0 : Math.floor(h / size) + 1;
  const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / size)));
  const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / size)));

  // CSR layout: start[c]..start[c + 1] index into `items` (positions in `ordered`, ascending).
  const counts = new Uint32Array(nx * ny + 1);
  const spans: Array<[number, number, number, number] | null> = boxes.map((b) => {
    if (!(b[0] <= b[2] && b[1] <= b[3])) return null;
    const pad = padOf(b);
    return [cx(b[0] - pad), cx(b[2] + pad), cy(b[1]), cy(b[3])];
  });
  for (const s of spans) {
    if (!s) continue;
    for (let j = s[2]; j <= s[3]; j++) for (let i = s[0]; i <= s[1]; i++) counts[j * nx + i + 1]!++;
  }
  for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
  const items = new Uint32Array(counts[counts.length - 1] ?? 0);
  const fill = counts.slice(0, Math.max(0, counts.length - 1));
  spans.forEach((s, k) => {
    if (!s) return;
    for (let j = s[2]; j <= s[3]; j++) for (let i = s[0]; i <= s[1]; i++) items[fill[j * nx + i]!++] = k;
  });

  return {
    size: ordered.length,
    byId: (id) => byId.get(id),
    locate(px, py) {
      if (empty || !(px >= x0 && px <= x1 && py >= y0 && py <= y1)) return undefined;
      const c = cy(py) * nx + cx(px);
      for (let t = counts[c]!; t < counts[c + 1]!; t++) {
        const k = items[t]!;
        if (bboxMayContain(boxes[k]!, px, py) && contains(ordered[k]!.geometry, px, py)) return ordered[k];
      }
      return undefined;
    },
  };
}
