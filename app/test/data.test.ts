import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClient, type MudskipperClient } from '../../core/src/client.ts';
import { nodeFixtureLoader } from '../../core/src/fixtures-node.ts';
import {
  adaptSnapshot,
  getApiFieldDetails,
  getApiOverlays,
  loadApiDataset,
} from '../src/data.ts';

const fixtures = () => createClient({ source: 'fixtures', load: nodeFixtureLoader() });
const snapshot = async () => JSON.parse(await readFile(new URL('../public/demo-data.json', import.meta.url), 'utf8'));

test('snapshot preserves the 375-field r01v1 data and confidence without inventing probabilities', async () => {
  const raw = await snapshot();
  const before = JSON.stringify(raw);
  const data = adaptSnapshot(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(data.kind, 'snapshot');
  assert.equal(data.run_id, 'r01v1');
  assert.deepEqual(data.passes, raw.passes);
  assert.deepEqual(data.passIds, raw.passes);
  assert.equal(data.passes.length, 9);
  assert.equal(data.tiles.fazilka.fields.length, 188);
  assert.equal(data.tiles.muktsar.fields.length, 187);
  assert.deepEqual(data.tiles.fazilka.fields[0], raw.tiles.fazilka.fields[0]);
  assert.equal(data.tiles.fazilka.fields[0].c[0], 0.88);
  assert.equal('p_flooded' in data.tiles.fazilka.fields[0], false);
  assert.deepEqual(data.gaps, [{ start: '2026-07-27', end: '2026-08-10' }]);
});

test('snapshot rejects misaligned arrays, duplicate ids, invalid geometry and unordered dates', async () => {
  for (const key of ['c', 'hh', 's']) {
    const raw = await snapshot();
    raw.tiles.fazilka.fields[0][key] = raw.tiles.fazilka.fields[0][key].slice(1);
    assert.throws(() => adaptSnapshot(raw), new RegExp(key));
  }
  const duplicate = await snapshot();
  duplicate.tiles.muktsar.fields[0].id = duplicate.tiles.fazilka.fields[0].id;
  assert.throws(() => adaptSnapshot(duplicate), /duplicate field/i);
  const empty = await snapshot();
  empty.tiles.fazilka.fields[0].poly = [];
  assert.throws(() => adaptSnapshot(empty), /poly|geometry|ring/i);
  const nonfinite = await snapshot();
  nonfinite.tiles.fazilka.fields[0].poly[0][0] = NaN;
  assert.throws(() => adaptSnapshot(nonfinite), /finite|position/i);
  const unordered = await snapshot();
  unordered.passes.reverse();
  assert.throws(() => adaptSnapshot(unordered), /order/i);
});

test('API conversion uses one coherent fixture run, real pass ids and exact geometry', async () => {
  const client = fixtures();
  let detailCalls = 0;
  const observedClient: MudskipperClient = { ...client, getField: async (id) => { detailCalls++; return client.getField(id); } };
  const [data, geo, states, meta] = await Promise.all([
    loadApiDataset(observedClient), client.getFieldsGeoJson(), client.getStates(), client.getMeta(),
  ]);
  const fields = Object.values(data.tiles).flatMap((tile) => tile.fields);
  assert.equal(data.kind, 'api');
  assert.equal(data.run_id, 'fixture');
  assert.equal(data.fixture, true);
  assert.equal(fields.length, 300);
  assert.equal(data.passes.length, 10);
  assert.equal(data.passes[0], '2026-06-23');
  assert.equal(data.passes.at(-1), '2026-10-21');
  assert.deepEqual(data.passIds, states.pass_ids);
  assert.deepEqual(data.apiMeta, meta);
  for (const feature of geo.features) {
    const field = fields.find((f) => f.id === feature.properties.field_id)!;
    assert.deepEqual(field.geometry, feature.geometry);
    assert.equal(field.ha, feature.properties.area_ha);
    assert.equal(field.rice, feature.properties.rice_mask_frac);
    assert.equal(field.s, states.states[states.field_ids.indexOf(field.id)].toLowerCase());
    assert.deepEqual(field.c, Array(10).fill(null));
    assert.deepEqual(field.hh, Array(10).fill(null));
    assert.equal('p_flooded' in field, false);
    assert.equal(data.fieldRows![field.id].field_id, field.id);
  }
  assert.equal(detailCalls, 0);
});

test('API conversion follows every fields page', async () => {
  const client = fixtures();
  const first = await client.getFields();
  const requested: number[] = [];
  const paginated: MudskipperClient = {
    ...client,
    getFields: async (query = {}) => {
      const page = query.page ?? 1;
      requested.push(page);
      return { ...first, page, page_size: 100, fields: first.fields.slice((page - 1) * 100, page * 100), next_page: page < 3 ? page + 1 : null };
    },
  };
  const data = await loadApiDataset(paginated);
  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(Object.values(data.tiles).flatMap((t) => t.fields).length, 300);
});

test('API geometry retains polygon holes and every MultiPolygon component', async () => {
  const client = fixtures();
  const geo = await client.getFieldsGeoJson();
  const original = geo.features[0].geometry;
  assert.equal(original.type, 'Polygon');
  const ring = original.coordinates[0];
  geo.features[0].geometry = { type: 'MultiPolygon', coordinates: [[ring, ring], [ring]] };
  const data = await loadApiDataset({ ...client, getFieldsGeoJson: async () => geo });
  const field = Object.values(data.tiles).flatMap((t) => t.fields).find((f) => f.id === geo.features[0].properties.field_id)!;
  assert.deepEqual(field.geometry, geo.features[0].geometry);
  assert.deepEqual(field.poly, ring);
});

test('API conversion rejects data from another run or fixture identity', async () => {
  const client = fixtures();
  const states = await client.getStates();
  await assert.rejects(loadApiDataset({ ...client, getStates: async () => ({ ...states, run_id: 'r01v1' }) }), /run_id/i);
  await assert.rejects(loadApiDataset({ ...client, getStates: async () => ({ ...states, fixture: false }) }), /fixture/i);
});

test('API conversion rejects misaligned pass, field and summary indexes', async () => {
  const client = fixtures();
  const states = await client.getStates();
  const page = await client.getFields();
  const missingPass = structuredClone(states);
  missingPass.pass_ids[0] = 'unknown';
  await assert.rejects(loadApiDataset({ ...client, getStates: async () => missingPass }), /pass/i);
  const swappedPass = structuredClone(states);
  swappedPass.pass_ids.reverse();
  await assert.rejects(loadApiDataset({ ...client, getStates: async () => swappedPass }), /pass.*order|order.*pass/i);
  const missingField = structuredClone(states);
  missingField.field_ids[0] = 'unknown-field';
  await assert.rejects(loadApiDataset({ ...client, getStates: async () => missingField }), /field/i);
  const wrongSummary = structuredClone(page);
  wrongSummary.fields[0].area_ha += 1;
  await assert.rejects(loadApiDataset({ ...client, getFields: async () => wrongSummary }), /area_ha|properties/i);
});

test('field detail keeps original inferred probabilities, with no confidence inversion', async () => {
  const client = fixtures();
  const data = await loadApiDataset(client);
  const id = Object.values(data.tiles)[0].fields[0].id;
  const expected = await client.getField(id);
  const detail = await getApiFieldDetails(client, data, id);
  assert.deepEqual(detail, expected);
  assert.equal(detail.observations[0].inferred.p_flooded, expected.observations[0].inferred.p_flooded);
});

test('field detail guards requested field, identity, geometry and observation pass', async () => {
  const client = fixtures();
  const data = await loadApiDataset(client);
  const id = Object.values(data.tiles)[0].fields[0].id;
  const detail = await client.getField(id);
  await assert.rejects(getApiFieldDetails(client, data, 'not-present'), /field/i);
  await assert.rejects(getApiFieldDetails({ ...client, getField: async () => ({ ...detail, run_id: 'r01v1' }) }, data, id), /run_id/i);
  const wrongField = structuredClone(detail);
  wrongField.field.properties.field_id = 'other';
  await assert.rejects(getApiFieldDetails({ ...client, getField: async () => wrongField }, data, id), /field/i);
  const wrongGeometry = structuredClone(detail);
  wrongGeometry.field.geometry = null;
  await assert.rejects(getApiFieldDetails({ ...client, getField: async () => wrongGeometry }, data, id), /geometry/i);
  const wrongPass = structuredClone(detail);
  wrongPass.observations[0].pass_id = 'not-present';
  await assert.rejects(getApiFieldDetails({ ...client, getField: async () => wrongPass }, data, id), /pass/i);
  await assert.rejects(getApiFieldDetails(client, adaptSnapshot(await snapshot()), id), /snapshot|API/i);
});

test('overlays require the same run and published pass/tile, preserve absence and HTTP errors', async () => {
  const client = fixtures();
  const data = await loadApiDataset(client);
  const expected = await client.getOverlaysIndex();
  assert.deepEqual(await getApiOverlays(client, data), expected);
  assert.equal(await getApiOverlays({ ...client, getOverlaysIndex: async () => null }, data), null);
  const error = new Error('HTTP 503');
  await assert.rejects(getApiOverlays({ ...client, getOverlaysIndex: async () => { throw error; } }, data), (caught) => caught === error);
  assert.ok(expected);
  await assert.rejects(getApiOverlays({ ...client, getOverlaysIndex: async () => ({ ...expected, run_id: 'r01v1' }) }, data), /run_id/i);
  const wrongPass = structuredClone(expected);
  wrongPass.overlays[0].pass_id = 'unknown';
  await assert.rejects(getApiOverlays({ ...client, getOverlaysIndex: async () => wrongPass }, data), /pass/i);
  const wrongTile = structuredClone(expected);
  wrongTile.overlays[0].tile = 'unknown';
  await assert.rejects(getApiOverlays({ ...client, getOverlaysIndex: async () => wrongTile }, data), /tile/i);
});
