import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandaloneLayerSources } from './layerSources.js';

function recordingMapTiles() {
  const mapTiles = [];
  const mapTileOptions = [];
  return {
    mapTiles,
    mapTileOptions,
    createMapTiles(options) {
      mapTileOptions.push(options);
      const source = {
        clears: 0,
        clear() {
          this.clears++;
        },
        getMetadata: async () => ({
          template: 'https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf',
        }),
        fetchBounds: async () => ({ tiles: [], loadedTiles: [] }),
      };
      mapTiles.push(source);
      return source;
    },
  };
}

test('traffic owns its local OpenFreeMap tiles; installations take none', () => {
  const tiles = recordingMapTiles();
  const sources = createStandaloneLayerSources({}, tiles);
  // Swedish fork: mapped installations are not offered, so only traffic
  // asks for map tiles.
  assert.equal(tiles.mapTiles.length, 1);
  const decoded = { roads: ['road'], military: ['site'] };
  assert.deepEqual(tiles.mapTileOptions[0].selectDecoded(decoded), {
    roads: ['road'],
  });
  sources.traffic.resetFlowTileCache();
  assert.deepEqual(
    tiles.mapTiles.map((source) => source.clears),
    [1],
  );
  sources.installations.destroy();
  assert.deepEqual(
    tiles.mapTiles.map((source) => source.clears),
    [1],
    'installation destroy cannot clear traffic work',
  );
});

test('the military source finds no aircraft and asks nobody', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request expected');
  });
  const { military } = createStandaloneLayerSources({}, recordingMapTiles());
  assert.deepEqual((await military.getSnapshot({})).records, []);
  assert.deepEqual(await military.getIdentities({}), []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('the installation source finds no sites and asks nobody', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request expected');
  });
  const { installations } = createStandaloneLayerSources(
    {},
    recordingMapTiles(),
  );
  const box = { south: 59.2, west: 17.8, north: 59.5, east: 18.3 };
  for (const exact of [false, true]) {
    const payload = await installations.getMappedSites(box, { exact });
    assert.deepEqual(payload.records, []);
    assert.equal(payload.saturated, false);
    assert.equal(payload.status, 'ok');
  }
  // A whole-country view, which would otherwise read the bundled names.
  const wide = await installations.getMappedSites({
    south: 55,
    west: 10,
    north: 69,
    east: 24,
  });
  assert.deepEqual(wide.records, []);
  assert.deepEqual(
    await installations.searchNearby({
      latitude: 59.33,
      longitude: 18.07,
      radiusM: 10_000,
    }),
    { places: [] },
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});
