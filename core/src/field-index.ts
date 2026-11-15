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
 * Built once per run: the Worker keeps it for the isolate's lifetime, and its ranking input ships the grid
 * (`index.grid`, rebuilt from the same boxes by `fieldIndex` at bundle time) so a cold isolate skips that
 * step too. A lookup touches a handful of fields instead of all 4,600.
 */
import { bboxMayContain, bboxOf, contains, containsFlat, type AreaGeometryInput, type BBox, type FlatPolygons } from "./geometry.ts";

/** What the index reads from a field (`fields.geojson` features and rank's `RankField` are assignable). */
export interface IndexedField {
  readonly geometry: AreaGeometryInput;
  readonly properties: { readonly field_id: string };
}

/**
 * The grid over the fields in field_id order: cell (i, j) of nx × ny lists the positions
 * `items[start[j * nx + i]] … items[start[j * nx + i + 1] - 1]`, ascending.
 */
export interface FieldGrid {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly size: number;
  readonly nx: number;
  readonly ny: number;
  readonly start: Uint32Array;
  readonly items: Uint32Array;
}

export interface FieldIndex<F extends IndexedField = IndexedField> {
  /** Number of fields. */
  readonly size: number;
  /** The grid, for callers that store it (the Worker's ranking input) and pass it back as `options.grid`. */
  readonly grid: FieldGrid;
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
  /**
   * A grid `fieldIndex` built earlier for the same fields and boxes (its `.grid`). Only accepted when `fields`
   * are already in field_id order, so its positions mean the same fields.
   */
  readonly grid?: FieldGrid;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const MAX_CELLS = 1 << 20;

/** The x padding `bboxMayContain` applies to `bbox`. */
function padOf(b: BBox): number {
  return 1e-9 * (Math.abs(b[0]) + Math.abs(b[2]) + 1);
}

const hasRing = (b: BBox) => b[0] <= b[2] && b[1] <= b[3]; // a field with no outer ring can contain nothing

export function isFieldIndex<F extends IndexedField>(x: ReadonlyArray<F> | FieldIndex<F>): x is FieldIndex<F> {
  return !Array.isArray(x) && typeof (x as FieldIndex<F>).locate === "function";
}

function cellOf(g: Pick<FieldGrid, "x0" | "y0" | "size" | "nx" | "ny">, x: number, y: number): [number, number] {
  return [
    Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.size))),
    Math.min(g.ny - 1, Math.max(0, Math.floor((y - g.y0) / g.size))),
  ];
}

function buildGrid(boxes: ReadonlyArray<BBox>, cellDeg: number | undefined): FieldGrid {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (!hasRing(b)) continue;
    const pad = padOf(b);
    x0 = Math.min(x0, b[0] - pad);
    x1 = Math.max(x1, b[2] + pad);
    y0 = Math.min(y0, b[1]);
    y1 = Math.max(y1, b[3]);
  }
  if (!(x0 <= x1 && y0 <= y1)) return { x0: 0, y0: 0, x1: -1, y1: -1, size: 1, nx: 0, ny: 0, start: new Uint32Array(1), items: new Uint32Array(0) };
  const w = x1 - x0;
  const h = y1 - y0;
  let size = cellDeg ?? Math.sqrt((w * h) / Math.max(1, boxes.length));
  if (!(size > 0) || !Number.isFinite(size)) size = Math.max(w, h, 1e-6);
  while (Math.ceil(w / size + 1) * Math.ceil(h / size + 1) > MAX_CELLS) size *= 2;
  const g = { x0, y0, x1, y1, size, nx: Math.floor(w / size) + 1, ny: Math.floor(h / size) + 1 };
  const spans = boxes.map((b) => {
    if (!hasRing(b)) return null;
    const pad = padOf(b);
    const [i0, j0] = cellOf(g, b[0] - pad, b[1]);
    const [i1, j1] = cellOf(g, b[2] + pad, b[3]);
    return [i0, i1, j0, j1] as const;
  });
  const start = new Uint32Array(g.nx * g.ny + 1);
  for (const s of spans) {
    if (!s) continue;
    for (let j = s[2]; j <= s[3]; j++) for (let i = s[0]; i <= s[1]; i++) start[j * g.nx + i + 1]!++;
  }
  for (let c = 1; c < start.length; c++) start[c]! += start[c - 1]!;
  const items = new Uint32Array(start[start.length - 1]!);
  const fill = start.slice(0, start.length - 1);
  spans.forEach((s, k) => {
    if (!s) return;
    for (let j = s[2]; j <= s[3]; j++) for (let i = s[0]; i <= s[1]; i++) items[fill[j * g.nx + i]!++] = k;
  });
  return { ...g, start, items };
}

/**
 * A run's fields as columns: ids, boxes and polygons in typed arrays, and field objects only on request.
 * The Worker's ranking input (platform/src/repo/rank-input.ts) is stored this way, so a cold isolate maps a
 * buffer instead of building thousands of objects.
 */
export interface FieldColumns<F extends IndexedField> extends FlatPolygons {
  /** Field ids in field_id (UTF-16 code-unit) order. */
  readonly ids: ReadonlyArray<string>;
  /** `bboxOf` of every field, four numbers each: minX, minY, maxX, maxY. */
  readonly boxes: Float64Array;
  /** The grid `fieldIndex` builds over these boxes (its `.grid`). */
  readonly grid: FieldGrid;
  /** The field at position k (called only for the fields a lookup returns; the caller may cache). */
  field(k: number): F;
}

/**
 * `fieldIndex` over columns. `locate` and `byId` return exactly what `fieldIndex` returns for the same fields
 * (containment is `containsFlat`, the same arithmetic as `contains`; for a repeated id, the last one wins).
 */
export function columnarFieldIndex<F extends IndexedField>(cols: FieldColumns<F>): FieldIndex<F> {
  const { ids, boxes, grid } = cols;
  const n = ids.length;
  if (boxes.length !== 4 * n || cols.parts.length !== n + 1) throw new RangeError("columns must have one entry per field");
  for (let k = 1; k < n; k++) if (ids[k - 1]! > ids[k]!) throw new RangeError("a prebuilt grid needs the fields in field_id order");
  const { x0, y0, x1, y1, nx, ny, size, start, items } = grid;
  if (start.length !== nx * ny + 1) throw new RangeError("the grid does not belong to these fields");
  for (let t = 0; t < items.length; t++) if (items[t]! >= n) throw new RangeError("the grid does not belong to these fields");

  /** Position of the last `id` in the sorted ids, or -1. */
  const positionOf = (id: string): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ids[mid]! <= id) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && ids[lo - 1] === id ? lo - 1 : -1;
  };

  return {
    size: n,
    grid,
    byId(id) {
      const k = positionOf(id);
      return k < 0 ? undefined : cols.field(k);
    },
    locate(px, py) {
      if (!(px >= x0 && px <= x1 && py >= y0 && py <= y1)) return undefined;
      // cellOf and bboxMayContain, inlined over the typed arrays (the same operations in the same order).
      const i = Math.min(nx - 1, Math.max(0, Math.floor((px - x0) / size)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor((py - y0) / size)));
      const c = j * nx + i;
      for (let t = start[c]!; t < start[c + 1]!; t++) {
        const k = items[t]!;
        const minX = boxes[4 * k]!;
        const minY = boxes[4 * k + 1]!;
        const maxX = boxes[4 * k + 2]!;
        const maxY = boxes[4 * k + 3]!;
        if (!(py >= minY && py < maxY)) continue;
        const pad = 1e-9 * (Math.abs(minX) + Math.abs(maxX) + 1);
        if (!(px >= minX - pad && px <= maxX + pad)) continue;
        if (containsFlat(cols, k, px, py)) return cols.field(k);
      }
      return undefined;
    },
  };
}

export function fieldIndex<F extends IndexedField>(fields: ReadonlyArray<F>, options: FieldIndexOptions = {}): FieldIndex<F> {
  if (options.boxes && options.boxes.length !== fields.length) throw new RangeError("boxes must have one entry per field");
  // Already in field_id order (the Worker's ranking input is): skip the sort, the order is the same.
  let sorted = true;
  for (let k = 1; k < fields.length && sorted; k++) sorted = byCodeUnits(fields[k - 1]!.properties.field_id, fields[k]!.properties.field_id) <= 0;
  let ordered: ReadonlyArray<F> = fields;
  let boxes: ReadonlyArray<BBox>;
  if (sorted) boxes = options.boxes ?? fields.map((f) => bboxOf(f.geometry));
  else {
    const order = fields.map((_, k) => k).sort((a, b) => byCodeUnits(fields[a]!.properties.field_id, fields[b]!.properties.field_id));
    ordered = order.map((k) => fields[k]!);
    boxes = order.map((k) => options.boxes?.[k] ?? bboxOf(fields[k]!.geometry));
  }
  if (options.grid && !sorted) throw new RangeError("a prebuilt grid needs the fields in field_id order");
  const grid = options.grid ?? buildGrid(boxes, options.cellDeg);
  if (grid.start.length !== grid.nx * grid.ny + 1 || grid.items.some((k) => k >= ordered.length)) {
    throw new RangeError("the grid does not belong to these fields");
  }
  const byId = new Map<string, F>();
  for (const f of fields) byId.set(f.properties.field_id, f); // a repeated id: the last one wins, as in rules.rank

  const { x0, y0, x1, y1, nx, start, items } = grid;
  return {
    size: ordered.length,
    grid,
    byId: (id) => byId.get(id),
    locate(px, py) {
      if (!(px >= x0 && px <= x1 && py >= y0 && py <= y1)) return undefined;
      const [i, j] = cellOf(grid, px, py);
      const c = j * nx + i;
      for (let t = start[c]!; t < start[c + 1]!; t++) {
        const k = items[t]!;
        if (bboxMayContain(boxes[k]!, px, py) && contains(ordered[k]!.geometry, px, py)) return ordered[k];
      }
      return undefined;
    },
  };
}
