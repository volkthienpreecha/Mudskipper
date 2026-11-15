import { createClient, type MudskipperClient } from '@mudskipper/core/client';
import { stageOf, uncertainState } from '@mudskipper/core';
import type {
  AreaGeometry,
  FieldDetail,
  FieldProperties,
  FieldRow,
  Meta,
  OverlaysIndex,
  Pass,
  Position,
} from '@mudskipper/core/contracts';

/** The snapshot stores confidence = abs(2 * p_flooded - 1), rounded. It is not accuracy. */
export interface DemoField {
  id: string;
  ha: number;
  rice: number | null;
  /** Compatibility outer ring; use geometry when present to retain holes and MultiPolygons. */
  poly: Position[];
  s: string;
  c: (number | null)[];
  hh: (number | null)[];
  geometry?: AreaGeometry;
}

export interface DemoTile {
  center: Position;
  fields: DemoField[];
  district: string;
}

export interface DemoDataset {
  kind: 'snapshot' | 'api';
  run_id: string;
  fixture: boolean;
  /** Date-only display labels, aligned one to one with passIds and every field's arrays. */
  passes: string[];
  /** Snapshot date keys, or the API's real pass_id values. No datetime is invented. */
  passIds: string[];
  tiles: Record<string, DemoTile>;
  gaps: { start: string; end: string }[];
  source?: { file: string; confidence: string };
  apiMeta?: Meta;
  apiPasses?: Pass[];
  fieldRows?: Record<string, FieldRow>;
}

export const DEFAULT_BACKEND_URL = 'https://mudskipper-nisar.pages.dev';

export function createBackend(baseUrl = DEFAULT_BACKEND_URL): MudskipperClient {
  return createClient({ source: 'api', baseUrl });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Dataset: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${context} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  check(typeof value === 'string' && value.trim().length > 0, `${context} must be a nonempty string`);
  return value;
}

function finite(value: unknown, context: string): number {
  check(typeof value === 'number' && Number.isFinite(value), `${context} must be finite`);
  return value;
}

function probability(value: unknown, context: string): number | null {
  if (value === null) return null;
  const number = finite(value, context);
  check(number >= 0 && number <= 1, `${context} must be between 0 and 1`);
  return number;
}

function position(value: unknown, context: string): Position {
  check(Array.isArray(value) && value.length === 2, `${context} position must contain longitude and latitude`);
  const lon = finite(value[0], `${context} longitude`);
  const lat = finite(value[1], `${context} latitude`);
  check(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90, `${context} position is outside geographic bounds`);
  return [lon, lat];
}

function ring(value: unknown, context: string): Position[] {
  check(Array.isArray(value) && value.length >= 4, `${context} ring must contain at least four positions`);
  const out = value.map((point, index) => position(point, `${context}[${index}]`));
  const first = out[0];
  const last = out[out.length - 1];
  check(first[0] === last[0] && first[1] === last[1], `${context} ring must be closed`);
  return out;
}

function validateGeometry(value: unknown, context: string): asserts value is AreaGeometry {
  const geometry = record(value, `${context} geometry`);
  check(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon', `${context} geometry must be Polygon or MultiPolygon`);
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  check(Array.isArray(polygons) && polygons.length > 0, `${context} geometry must contain polygons`);
  polygons.forEach((polygon, polygonIndex) => {
    check(Array.isArray(polygon) && polygon.length > 0, `${context} polygon ${polygonIndex} must contain rings`);
    polygon.forEach((linearRing, ringIndex) => ring(linearRing, `${context} polygon ${polygonIndex} ring ${ringIndex}`));
  });
}

function date(value: unknown, context: string): string {
  const result = text(value, context);
  check(/^\d{4}-\d{2}-\d{2}$/.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString().slice(0, 10) === result, `${context} must be a calendar date (YYYY-MM-DD)`);
  return result;
}

function datetime(value: unknown, context: string): number {
  const string = text(value, context);
  check(/^\d{4}-\d{2}-\d{2}T/.test(string) && Number.isFinite(Date.parse(string)), `${context} must be a valid datetime`);
  date(string.slice(0, 10), context);
  return Date.parse(string);
}

function unique(values: readonly string[], context: string): void {
  check(new Set(values).size === values.length, `duplicate ${context}`);
}

function sameIdentity(value: { run_id: string; fixture?: boolean }, dataset: Pick<DemoDataset, 'run_id' | 'fixture'>, context: string): void {
  check(value.run_id === dataset.run_id, `${context} run_id ${JSON.stringify(value.run_id)} does not match ${JSON.stringify(dataset.run_id)}`);
  check(value.fixture === undefined || typeof value.fixture === 'boolean', `${context} fixture must be boolean`);
  // Artifact contracts may omit fixture for a non-fixture run. A fixture run must explicitly say true.
  check((value.fixture === true) === dataset.fixture, `${context} fixture does not match dataset`);
}

/** Adapt the redesign's committed r01v1 data without changing its values or its date-only provenance. */
export function adaptSnapshot(raw: unknown): DemoDataset {
  const source = record(raw, 'snapshot');
  const run_id = text(source.run_id, 'snapshot run_id');
  check(source.fixture === undefined || typeof source.fixture === 'boolean', 'snapshot fixture must be boolean');
  check(Array.isArray(source.passes) && source.passes.length > 0, 'snapshot passes must be nonempty');
  const passes = source.passes.map((value, index) => date(value, `snapshot passes[${index}]`));
  check(passes.every((value, index) => index === 0 || value > passes[index - 1]), 'snapshot passes must be in strictly increasing date order');
  const rawTiles = record(source.tiles, 'snapshot tiles');
  check(Object.keys(rawTiles).length > 0, 'snapshot tiles must be nonempty');
  const tiles: Record<string, DemoTile> = Object.create(null);
  const ids: string[] = [];
  for (const [tileId, rawTile] of Object.entries(rawTiles)) {
    text(tileId, 'tile id');
    const tile = record(rawTile, `tile ${tileId}`);
    check(Array.isArray(tile.fields), `tile ${tileId} fields must be an array`);
    const fields = tile.fields.map((rawField, index): DemoField => {
      const context = `tile ${tileId} field ${index}`;
      const field = record(rawField, context);
      const id = text(field.id, `${context} id`);
      ids.push(id);
      const ha = finite(field.ha, `${id} ha`);
      check(ha > 0, `${id} ha must be positive`);
      const rice = probability(field.rice, `${id} rice`);
      const poly = ring(field.poly, `${id} poly`);
      check(typeof field.s === 'string' && field.s.length === passes.length && /^[fdu-]+$/.test(field.s), `${id} s must contain one f/d/u/- state per pass`);
      const series = (key: 'c' | 'hh'): (number | null)[] => {
        const values = field[key];
        check(Array.isArray(values) && values.length === passes.length, `${id} ${key} must contain one value per pass`);
        return values.map((value, passIndex) => value === null ? null : key === 'c' ? probability(value, `${id} c[${passIndex}]`) : finite(value, `${id} hh[${passIndex}]`));
      };
      return { id, ha, rice, poly, s: field.s, c: series('c'), hh: series('hh') };
    });
    const district = typeof tile.district === 'string' ? tile.district : ({ fazilka: 'Fazilka', muktsar: 'Sri Muktsar Sahib' }[tileId] ?? tileId);
    tiles[tileId] = { center: position(tile.center, `${tileId} center`), fields, district };
  }
  check(ids.length > 0, 'snapshot must contain fields');
  unique(ids, 'field ids');
  return {
    kind: 'snapshot', run_id, fixture: source.fixture === true,
    passes, passIds: [...passes], tiles,
    gaps: [{ start: '2026-07-27', end: '2026-08-10' }],
    source: { file: 'demo-data.json', confidence: 'abs(2 * p_flooded - 1), rounded; not probability or accuracy' },
  };
}

const PROPERTY_KEYS = ['field_id', 'tile', 'district', 'area_ha', 'source', 'rice_mask_frac', 'lon', 'lat'] as const;

function matchingProperties(properties: FieldProperties, row: FieldRow, context: string): void {
  for (const key of PROPERTY_KEYS) check(properties[key] === row[key], `${context} properties.${key} does not match fields summary`);
}

/** Fetch only shared run data. Detailed per-field observations remain lazy. */
export async function loadApiDataset(client: MudskipperClient): Promise<DemoDataset> {
  const [meta, passesResponse, states, geo, firstPage] = await Promise.all([
    client.getMeta(), client.getPasses(), client.getStates(), client.getFieldsGeoJson(), client.getFields({ page: 1 }),
  ]);
  text(meta.run_id, 'API meta run_id');
  check(typeof meta.fixture === 'boolean', 'API meta fixture must be boolean');
  for (const [name, response] of [['passes', passesResponse], ['states', states], ['geometry', geo], ['fields page 1', firstPage]] as const) sameIdentity(response, meta, name);

  const allPasses = passesResponse.passes;
  check(Array.isArray(allPasses) && allPasses.length > 0, 'API passes must be nonempty');
  unique(allPasses.map((pass) => text(pass.pass_id, 'API pass_id')), 'pass ids');
  for (const pass of allPasses) datetime(pass.datetime, `pass ${pass.pass_id} datetime`);
  const usedPasses = allPasses.filter((pass) => pass.used).sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime) || (a.pass_id < b.pass_id ? -1 : a.pass_id > b.pass_id ? 1 : 0));
  check(usedPasses.length > 0, 'API must contain used passes');
  check(Array.isArray(states.pass_ids) && states.pass_ids.length === usedPasses.length, 'states pass ids do not match used passes');
  unique(states.pass_ids, 'states pass ids');
  check(states.pass_ids.every((id, index) => id === usedPasses[index].pass_id), 'states pass ids must match used passes in datetime order');
  check(meta.counts.passes === allPasses.length && meta.counts.passes_used === usedPasses.length, 'API meta pass counts do not match passes');

  const rows: FieldRow[] = [];
  const seenPages = new Set<number>();
  let page = firstPage;
  let expectedPage = 1;
  const total = firstPage.total;
  check(Number.isInteger(total) && total > 0, 'API fields total must be positive');
  while (true) {
    sameIdentity(page, meta, `fields page ${expectedPage}`);
    check(page.page === expectedPage && !seenPages.has(page.page), 'API fields pagination repeated or unexpected page');
    seenPages.add(page.page);
    check(page.total === total && Number.isInteger(page.page_size) && page.page_size > 0, 'API fields pagination totals or page size changed');
    check(page.filters.tile === null && page.filters.verdict === null, 'API fields page must contain unfiltered fields');
    check(Array.isArray(page.fields) && page.fields.length <= page.page_size, 'API fields page size does not match rows');
    rows.push(...page.fields);
    check(rows.length <= total, 'API fields pages exceed total');
    if (page.next_page === null) break;
    check(page.fields.length > 0 && Number.isInteger(page.next_page) && page.next_page === expectedPage + 1, 'API fields next page must advance');
    expectedPage = page.next_page;
    page = await client.getFields({ page: expectedPage });
  }
  check(rows.length === total && total === meta.counts.fields, 'API field counts do not match metadata');
  unique(rows.map((row) => text(row.field_id, 'fields summary field_id')), 'fields summary field ids');
  const fieldRows: Record<string, FieldRow> = Object.create(null);
  for (const row of rows) fieldRows[row.field_id] = row;

  check(geo.type === 'FeatureCollection' && Array.isArray(geo.features) && geo.features.length === total, 'API geometry field count does not match summary');
  unique(geo.features.map((feature) => text(feature.properties.field_id, 'geometry field_id')), 'geometry field ids');
  check(Array.isArray(states.field_ids) && Array.isArray(states.states) && states.field_ids.length === total && states.states.length === total, 'API states field indexes do not match field count');
  unique(states.field_ids, 'states field ids');
  const stateById = new Map<string, string>();
  states.field_ids.forEach((id, index) => {
    check(fieldRows[id] !== undefined, `states field ${id} is absent from summary`);
    const sequence = states.states[index];
    check(typeof sequence === 'string' && sequence.length === usedPasses.length && /^[FDU-]+$/.test(sequence), `${id} states must contain one F/D/U/- state per used pass`);
    stateById.set(id, sequence.toLowerCase());
  });

  check(Array.isArray(meta.tiles) && meta.tiles.length > 0, 'API tiles must be nonempty');
  unique(meta.tiles.map((tile) => text(tile.id, 'API tile id')), 'tile ids');
  const tiles: Record<string, DemoTile> = Object.create(null);
  for (const tile of meta.tiles) {
    check(Array.isArray(tile.bbox) && tile.bbox.length === 4, `${tile.id} bbox must contain four coordinates`);
    const [west, south] = position(tile.bbox.slice(0, 2), `${tile.id} bbox southwest`);
    const [east, north] = position(tile.bbox.slice(2, 4), `${tile.id} bbox northeast`);
    check(west < east && south < north, `${tile.id} bbox must have positive extent`);
    tiles[tile.id] = { center: [(west + east) / 2, (south + north) / 2], district: text(tile.district, `${tile.id} district`), fields: [] };
  }
  for (const feature of geo.features) {
    const properties = feature.properties;
    const id = properties.field_id;
    const row = fieldRows[id];
    check(row !== undefined, `geometry field ${id} is absent from summary`);
    matchingProperties(properties, row, id);
    const tile = tiles[properties.tile];
    check(tile !== undefined, `${id} references unknown tile ${properties.tile}`);
    check(tile.district === properties.district, `${id} district does not match its tile`);
    check(finite(properties.area_ha, `${id} area_ha`) > 0, `${id} area_ha must be positive`);
    probability(properties.rice_mask_frac, `${id} rice_mask_frac`);
    position([properties.lon, properties.lat], `${id} centroid`);
    validateGeometry(feature.geometry, id);
    const s = stateById.get(id);
    check(s !== undefined, `${id} is absent from state indexes`);
    tile.fields.push({
      id, ha: properties.area_ha, rice: properties.rice_mask_frac,
      poly: feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0],
      geometry: feature.geometry, s,
      c: Array(usedPasses.length).fill(null), hh: Array(usedPasses.length).fill(null),
    });
  }
  const gaps = meta.gaps.map((gap, index) => {
    check(datetime(gap.start, `gap ${index} start`) < datetime(gap.end, `gap ${index} end`), `gap ${index} must have positive duration`);
    return { start: gap.start.slice(0, 10), end: gap.end.slice(0, 10) };
  });
  return {
    kind: 'api', run_id: meta.run_id, fixture: meta.fixture,
    passes: usedPasses.map((pass) => pass.datetime.slice(0, 10)), passIds: [...states.pass_ids],
    tiles, gaps, apiMeta: meta, apiPasses: allPasses, fieldRows,
  };
}

function requireApi(dataset: DemoDataset): void {
  check(dataset.kind === 'api' && dataset.apiMeta && dataset.apiPasses && dataset.fieldRows, 'API helpers require an API dataset; snapshot fields cannot use API evidence');
}

/** Return original API evidence after confirming it belongs to the selected dataset and field. */
export async function getApiFieldDetails(client: MudskipperClient, dataset: DemoDataset, id: string): Promise<FieldDetail> {
  requireApi(dataset);
  const row = dataset.fieldRows![id];
  const field = Object.values(dataset.tiles).flatMap((tile) => tile.fields).find((candidate) => candidate.id === id);
  check(row && field, `field ${id} does not exist in selected API dataset`);
  const detail = await client.getField(id);
  sameIdentity(detail, dataset, `field ${id} detail`);
  check(detail.field.properties.field_id === id, `field detail id does not match requested field ${id}`);
  matchingProperties(detail.field.properties, row, `field ${id} detail`);
  validateGeometry(detail.field.geometry, `field ${id} detail`);
  check(detail.field.geometry.type === field.geometry?.type && JSON.stringify(detail.field.geometry.coordinates) === JSON.stringify(field.geometry?.coordinates), `field ${id} detail geometry does not match selected dataset`);
  const passById = new Map(dataset.apiPasses!.map((pass) => [pass.pass_id, pass]));
  const seen = new Set<string>();
  check(Array.isArray(detail.observations), `field ${id} observations must be an array`);
  for (const observation of detail.observations) {
    const passIndex = dataset.passIds.indexOf(observation.pass_id);
    const pass = passById.get(observation.pass_id);
    check(passIndex !== -1 && pass?.used && !seen.has(observation.pass_id), `field ${id} observation has unknown, excluded or duplicate pass ${observation.pass_id}`);
    seen.add(observation.pass_id);
    check(observation.datetime === pass.datetime, `field ${id} observation datetime does not match pass ${observation.pass_id}`);
    const state = { flooded: 'f', drained: 'd', uncertain: 'u' }[observation.inferred.state];
    check(state && state === field.s[passIndex], `field ${id} observation state does not match pass ${observation.pass_id}`);
    probability(observation.inferred.p_flooded, `${id} p_flooded`);
    probability(observation.inferred.confidence, `${id} confidence`);
    const valid = probability(observation.valid_frac, `${id} valid_frac`);
    check(valid !== null, `${id} valid_frac must not be null`);
    check(Number.isInteger(observation.n_px) && observation.n_px >= 0, `${id} n_px must be a nonnegative integer`);
    check(observation.stage === stageOf(observation.datetime, dataset.apiMeta!.stages), `${id} observation stage does not match pass ${observation.pass_id}`);
    check(observation.inferred.state === uncertainState(observation.inferred.p_flooded, valid), `${id} inferred state does not match probability and valid coverage`);
    check(dataset.apiMeta!.methods.includes(observation.inferred.method), `${id} method is absent from run metadata`);
    check(pass.pol_mode !== 'DH' || observation.inferred.method === 'hhhv_v1', `${id} dual-pol observation must use hhhv_v1`);
    for (const [key, value] of Object.entries(observation.observed)) {
      if (value !== null && value !== undefined) finite(value, `${id} ${key}`);
    }
    check(Array.isArray(observation.flags) && observation.flags.every((flag) => typeof flag === 'string'), `${id} flags must be strings`);
  }
  dataset.passIds.forEach((passId, index) => check(field.s[index] === '-' || seen.has(passId), `field ${id} is missing observation for pass ${passId}`));
  if (detail.summary) {
    const summary = detail.summary;
    check(summary.awd.verdict === row.awd_verdict && summary.awd.clear_looks === row.clear_looks && summary.awd.drained_hits === row.drained_hits && summary.awd.p_catch_ge1_if_awd === row.p_catch && summary.dsr.signal === row.dsr_signal, `field ${id} detail summary does not match selected dataset`);
  } else {
    check(row.awd_verdict === null && row.dsr_signal === null, `field ${id} detail is missing its published summary`);
  }
  return detail;
}

/** Absence is null; HTTP and validation failures propagate without being hidden. */
export async function getApiOverlays(client: MudskipperClient, dataset: DemoDataset): Promise<OverlaysIndex | null> {
  requireApi(dataset);
  const index = await client.getOverlaysIndex();
  if (index === null) return null;
  sameIdentity(index, dataset, 'overlays');
  check(Array.isArray(index.overlays), 'overlays must be an array');
  const keys = new Set<string>();
  for (const overlay of index.overlays) {
    check(dataset.passIds.includes(overlay.pass_id), `overlay references unknown or excluded pass ${overlay.pass_id}`);
    check(Object.hasOwn(dataset.tiles, overlay.tile), `overlay references unknown tile ${overlay.tile}`);
    const key = `${overlay.pass_id}/${overlay.tile}`;
    check(!keys.has(key), `duplicate overlay pass/tile ${key}`);
    keys.add(key);
    text(overlay.url, `overlay ${key} URL`);
    check(Array.isArray(overlay.coordinates) && overlay.coordinates.length === 4, `overlay ${key} must contain four coordinates`);
    overlay.coordinates.forEach((point) => position(point, `overlay ${key}`));
  }
  return index;
}
