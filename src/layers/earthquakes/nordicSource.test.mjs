// The earthquake layer's source in the Swedish fork: USGS's world with the
// EMSC's Nordic quakes in place of USGS's own there.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNordicEarthquakeSource,
  emscRow,
  mergeNordicRows,
} from './nordicSource.js';

const usgs = [
  { stableId: 'us1', lat: 35, lon: 140, mag: 5 },
  { stableId: 'us2', lat: 62, lon: 5, mag: 2.8, time: 30_000 },
  // In the box but not in the EMSC's answer (newer, or typed otherwise).
  { stableId: 'us3', lat: 60, lon: 20, mag: 3.1, time: 90_000_000 },
];
const emsc = [
  {
    id: 'e1',
    lat: 61.9,
    lon: 5.1,
    depthKm: 10,
    mag: 2.7,
    magType: 'ML',
    time: 1,
    region: 'Southern Norway',
  },
  { id: 'e2', lat: 40, lon: 20, mag: 3, time: 2, region: 'Greece' },
];

test('a quake in both lists is drawn once, from the EMSC; one only USGS has stays', () => {
  assert.deepEqual(
    mergeNordicRows(usgs, emsc).map((row) => row.stableId),
    ['us1', 'us3', 'emsc:e1'],
  );
  // An empty EMSC answer hides nothing.
  assert.deepEqual(
    mergeNordicRows(usgs, []).map((row) => row.stableId),
    ['us1', 'us2', 'us3'],
  );
  // No EMSC answer: USGS's rows as they were.
  assert.equal(mergeNordicRows(usgs, null), usgs);
  assert.equal(emscRow(emsc[0]).place, 'Southern Norway (EMSC, ML)');
  assert.equal(emscRow(emsc[0]).usgsId, null);
});

test('the EMSC route failing leaves the world feed working', async () => {
  const source = createNordicEarthquakeSource({
    usgs: { getSnapshot: async () => usgs },
    fetchImpl: async () => new Response('', { status: 502 }),
  });
  assert.deepEqual(await source.getSnapshot(), usgs);
  const working = createNordicEarthquakeSource({
    usgs: { getSnapshot: async () => usgs },
    fetchImpl: async (url) => {
      assert.equal(url, '/api/emsc-nordic');
      return new Response(JSON.stringify({ events: emsc }));
    },
  });
  assert.equal((await working.getSnapshot()).length, 3);
});
