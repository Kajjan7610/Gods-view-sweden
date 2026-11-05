// The Weather card lists the worst readings in view, so it must follow the
// camera between the 20-minute data refreshes; a clicked station opens a card.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStationCard,
  createAirQualityLayer,
  readingsInView,
} from './index.js';

function fakeViewer() {
  const listeners = new Set();
  return {
    dataSources: { add() {}, remove() {} },
    camera: {
      moveEnd: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    settle: () => listeners.forEach((listener) => listener()),
    listeners,
  };
}

test('a settled camera re-reads the card while the layer is on', () => {
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = fakeViewer();
  let reads = 0;
  layer.init(viewer);
  layer.setRowControlsListener(() => (reads += 1));

  viewer.settle();
  assert.equal(reads, 0, 'off: the camera is not followed');

  layer.enable();
  layer.enable();
  assert.equal(viewer.listeners.size, 1, 'one subscription, however often');
  reads = 0;
  viewer.settle();
  assert.equal(reads, 1);

  layer.disable();
  assert.equal(viewer.listeners.size, 0);
  layer.enable();
  layer.destroy(viewer);
  assert.equal(viewer.listeners.size, 0, 'destroy lets go of the camera');
});

test('a visibility test picks the readings in view', () => {
  const rows = [
    { id: 'a', stationId: 'a', value: 2, lat: 64.75 },
    { id: 'b', stationId: 'b', value: 5, lat: 66 },
    { id: 'c', stationId: 'c', value: 4, lat: 60 },
  ];
  assert.deepEqual(
    readingsInView(rows, (reading) => reading.lat < 65, 5).map((r) => r.id),
    ['c', 'a'],
  );
});

const GAVLE = Object.freeze({
  id: 'smhi:60.6745,17.1426',
  provider: 'smhi',
  scale: 'EAQI',
  value: 4,
  band: 'high',
  stationId: '60.6745,17.1426',
  name: 'Gävle Staketgatan',
  lat: 60.6745,
  lon: 17.1426,
  observedMs: Date.parse('2026-11-05T09:00:00Z'),
  color: '#ff6b35',
  label: '4',
  risk: 'High health risk',
  note: 'NO2 21.4 · PM10 98 · PM2.5 12.3 µg/m³',
});

test('the station card names the index, what was measured and the network', () => {
  const card = buildStationCard({
    ...GAVLE,
    note: `${'NO2 21.4 · PM10 98 · PM2.5 12.3 · O3 40.1 · '.repeat(3)}µg/m³`,
  });
  assert.equal(card.title, 'AIR QUALITY · GÄVLE STAKETGATAN');
  assert.equal(card.details[0], 'EAQI 4 · High health risk');
  assert.match(card.details.at(-2), /^Measured \d\d.\d\d/);
  assert.equal(card.details.at(-1), 'SMHI');
  for (const line of card.details) assert.ok(line.length <= 80, line);
  assert.equal(card.accent, '#ff6b35');
});

test('clicking a station opens its card; empty ground closes it', async () => {
  const cards = [];
  const owners = new Map();
  let click = null;
  let picked;
  const viewer = {
    ...fakeViewer(),
    scene: { pick: () => picked },
  };
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [GAVLE] },
    overlayHost: {
      setEntries(sourceId, entries) {
        if (sourceId === 'air-quality-card') cards.push(entries);
      },
      setVisible() {},
      clearSource() {},
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (action) => (click = action),
      destroy: () => (click = null),
    }),
    picking: {
      resolvePickId: (hit) => hit?.id?.id ?? null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner: (id, predicate) => owners.set(id, predicate),
      unregisterPickOwner: (id) => owners.delete(id),
    },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.ok(owners.get('air-quality')(`air-quality:${GAVLE.id}`));

  picked = { id: { id: `air-quality:${GAVLE.id}` } };
  click({ position: { x: 10, y: 10 } });
  assert.equal(cards.at(-1)[0].title, 'AIR QUALITY · GÄVLE STAKETGATAN');

  picked = undefined;
  click({ position: { x: 20, y: 20 } });
  assert.deepEqual(cards.at(-1), []);

  layer.disable();
  assert.equal(click, null, 'disable removes the click handler');
  assert.equal(owners.size, 0);
  layer.destroy(viewer);
});
