/**
 * Planar geometry for claim matching (CONTRACTS.md B6 ranking step 1). Python reference:
 * `rules.planar_area`, `rules.check_rings`, `rules.representative_point`, `rules._in_ring`, `rules.contains`.
 *
 * Everything works in lon/lat degrees with plain arithmetic and no trigonometry, so both languages agree
 * exactly. Positions may carry an altitude; only [0] and [1] are read.
 */

export type Pos = ReadonlyArray<number>;
export type Ring = ReadonlyArray<Pos>;
export type PointGeometry = { readonly type: "Point"; readonly coordinates: Pos };
export type PolygonGeometry = { readonly type: "Polygon"; readonly coordinates: ReadonlyArray<Ring> };
export type MultiPolygonGeometry = {
  readonly type: "MultiPolygon";
  readonly coordinates: ReadonlyArray<ReadonlyArray<Ring>>;
};
export type AreaGeometryInput = PolygonGeometry | MultiPolygonGeometry;
export type GeometryInput = PointGeometry | AreaGeometryInput;

/** Claim geometry the ranking cannot use: open ring, too few positions, unsupported type, no interior. */
export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeometryError";
  }
}

const x = (p: Pos): number => p[0] as number;
const y = (p: Pos): number => p[1] as number;

/** Polygons as lists of rings (outer ring first). */
export function ringsOf(geometry: { readonly type: string; readonly coordinates?: unknown }): ReadonlyArray<ReadonlyArray<Ring>> {
  if (geometry.type === "Polygon") return [(geometry as PolygonGeometry).coordinates];
  if (geometry.type === "MultiPolygon") return (geometry as MultiPolygonGeometry).coordinates;
  throw new GeometryError(`unsupported geometry type ${JSON.stringify(geometry.type)}`);
}

/** |shoelace| / 2 in lon/lat units; only used to pick the largest part of a MultiPolygon. */
export function planarArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    s += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return Math.abs(s) / 2;
}

/** Every ring must be closed (first position equals last) and have at least 4 positions. */
export function checkRings(geometry: AreaGeometryInput | { readonly type: string; readonly coordinates?: unknown }): void {
  for (const poly of ringsOf(geometry)) {
    for (const ring of poly) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (ring.length < 4 || first === undefined || last === undefined || x(first) !== x(last) || y(first) !== y(last)) {
        throw new GeometryError("polygon rings must be closed and have at least 4 positions");
      }
    }
  }
}

/**
 * Even-odd ray casting with the exact contract predicate:
 * `(yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi`, j starting at the last position.
 */
export function inRing(px: number, py: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  if (n === 0) return false;
  const pj = ring[n - 1]!;
  let xj = pj[0] as number;
  let yj = pj[1] as number;
  for (let i = 0; i < n; i++) {
    const pi = ring[i]!;
    const xi = pi[0] as number;
    const yi = pi[1] as number;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    xj = xi;
    yj = yi;
  }
  return inside;
}

/** Inside some part's outer ring and inside none of that part's holes. */
export function contains(geometry: AreaGeometryInput, px: number, py: number): boolean {
  for (const poly of ringsOf(geometry)) {
    const outer = poly[0];
    if (!outer || !inRing(px, py, outer)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length && !inHole; h++) inHole = inRing(px, py, poly[h]!);
    if (!inHole) return true;
  }
  return false;
}

/**
 * Polygons as typed arrays (the Worker's ranking input, platform/src/repo/rank-input.ts): field k owns
 * polygons `parts[k] … parts[k+1] - 1`, polygon p owns rings `rings[p] … rings[p+1] - 1` (outer ring first),
 * ring r owns positions `verts[r] … verts[r+1] - 1`, and position v is `coords[2v], coords[2v + 1]`.
 */
export interface FlatPolygons {
  readonly parts: Uint32Array;
  readonly rings: Uint32Array;
  readonly verts: Uint32Array;
  readonly coords: Float64Array;
}

/** `inRing` over ring r of flat polygons: the same predicate on the same doubles, in the same order. */
function inFlatRing(px: number, py: number, g: FlatPolygons, r: number): boolean {
  const v0 = g.verts[r]!;
  const v1 = g.verts[r + 1]!;
  if (v1 === v0) return false;
  const c = g.coords;
  let inside = false;
  let xj = c[2 * (v1 - 1)]!;
  let yj = c[2 * (v1 - 1) + 1]!;
  for (let v = v0; v < v1; v++) {
    const xi = c[2 * v]!;
    const yi = c[2 * v + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    xj = xi;
    yj = yi;
  }
  return inside;
}

/** `contains` for field k of flat polygons, exactly: true iff `contains(geometry of field k, px, py)`. */
export function containsFlat(g: FlatPolygons, k: number, px: number, py: number): boolean {
  for (let p = g.parts[k]!; p < g.parts[k + 1]!; p++) {
    const r0 = g.rings[p]!;
    const r1 = g.rings[p + 1]!;
    if (r1 === r0 || !inFlatRing(px, py, g, r0)) continue;
    let inHole = false;
    for (let r = r0 + 1; r < r1 && !inHole; r++) inHole = inFlatRing(px, py, g, r);
    if (!inHole) return true;
  }
  return false;
}

/**
 * B6 claim point. A Point is itself. A (Multi)Polygon: the part whose outer ring has the largest
 * `planarArea` (strictly larger wins, so the first part wins ties); the average of its vertices (closing
 * vertex excluded) if that lies inside the outer ring; otherwise the midpoint of the first two crossings of
 * the horizontal line through that average (the concave fallback).
 */
export function representativePoint(geometry: GeometryInput): [number, number] {
  if (geometry.type === "Point") return [x(geometry.coordinates), y(geometry.coordinates)];
  checkRings(geometry);
  const polys = ringsOf(geometry);
  if (polys.length === 0 || polys[0]!.length === 0) throw new GeometryError("polygon has no rings");
  let best = polys[0]!;
  let bestArea = planarArea(best[0]!);
  for (let q = 1; q < polys.length; q++) {
    const poly = polys[q]!;
    if (poly.length === 0) throw new GeometryError("polygon has no rings");
    const a = planarArea(poly[0]!);
    if (a > bestArea) {
      best = poly;
      bestArea = a;
    }
  }
  const outer = best[0]!;
  const n = outer.length - 1;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const p = outer[i]!;
    sx += p[0] as number;
    sy += p[1] as number;
  }
  const cx = sx / n;
  const cy = sy / n;
  if (inRing(cx, cy, outer)) return [cx, cy];
  const xs: number[] = [];
  let j = outer.length - 1;
  for (let i = 0; i < outer.length; i++) {
    const xi = x(outer[i]!);
    const yi = y(outer[i]!);
    const xj = x(outer[j]!);
    const yj = y(outer[j]!);
    if (yi > cy !== yj > cy) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi);
    j = i;
  }
  xs.sort((a, b) => a - b);
  // The Python reference raises IndexError here (a degenerate, zero-area ring); core reports it as bad geometry.
  if (xs.length < 2) throw new GeometryError("polygon has no interior (degenerate ring)");
  return [(xs[0]! + xs[1]!) / 2, cy];
}

export type BBox = readonly [minX: number, minY: number, maxX: number, maxY: number];

/** The bounding box of every outer ring (holes lie inside their outer ring). */
export function bboxOf(geometry: AreaGeometryInput): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of ringsOf(geometry)) {
    for (const p of poly[0] ?? []) {
      if (x(p) < minX) minX = x(p);
      if (x(p) > maxX) maxX = x(p);
      if (y(p) < minY) minY = y(p);
      if (y(p) > maxY) maxY = y(p);
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * A prefilter for `contains` that can never change its result: false only where `contains` is false too.
 *
 * Why it is exact: a ring edge toggles only when `(yi > py) != (yj > py)`, which needs minY ≤ py < maxY
 * (pure comparisons, no rounding). Along x, the computed crossing can stray from its edge's x-range by a few
 * ulps, so the x test is padded by 1e-9 · (|minX| + |maxX| + 1), many orders of magnitude more than that
 * error. Outside the padded range every crossing lies on one side of the point, and a closed ring has an
 * even number of crossings, so the ray-cast result is "outside" anyway.
 */
export function bboxMayContain(bbox: BBox, px: number, py: number): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  if (!(py >= minY && py < maxY)) return false;
  const pad = 1e-9 * (Math.abs(minX) + Math.abs(maxX) + 1);
  return px >= minX - pad && px <= maxX + pad;
}
