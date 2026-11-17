// The Weather card lists the worst readings in view, so it must follow the
// camera between the 20-minute data refreshes; a clicked station opens a card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import {
  buildStationCard,
  createAirQualityLayer,
  readingsInView,
} from './index.js';

/** A viewer drawn on through the fake draw port, with a camera port. */
function fakeViewer(renderer = {}) {
  const camera = fakeCameraPort();
  const viewer = { canvas: renderer.canvas };
  const { draw } = bindFakeDraw(viewer, { camera: camera.port, ...renderer });
  return {
    viewer,
    draw,
    settle: () => camera.emit('moveEnd'),
    listeners: () => camera.listenerCount('moveEnd'),
  };
}

test('a settled camera re-reads the card while the layer is on', () => {
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const fake = fakeViewer();
  let reads = 0;
  layer.init(fake.viewer);
  layer.setRowControlsListener(() => (reads += 1));

  fake.settle();
  assert.equal(reads, 0, 'off: the camera is not followed');

  layer.enable();
  layer.enable();
  assert.equal(fake.listeners(), 1, 'one subscription, however often');
  reads = 0;
  fake.settle();
  assert.equal(reads, 1);

  layer.disable();
  assert.equal(fake.listeners(), 0);
  layer.enable();
  layer.destroy();
  assert.equal(fake.listeners(), 0, 'destroy lets go of the camera');
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

test('the card lists the stations on screen and on the near side of the globe', async () => {
  // Projected by latitude: north of 65° is above the canvas; Kiruna's
  // longitude is behind the horizon.
  const projectLat = (position) => {
    const lat =
      (Math.asin(position.z / Math.hypot(position.x, position.y, position.z)) *
        180) /
      Math.PI;
    return { x: 100, y: (65 - lat) * 10 };
  };
  const fake = fakeViewer({
    canvas: { clientWidth: 800, clientHeight: 600 },
    query: {
      project: projectLat,
      isOccluded: (position) => position.y > 0 && position.x < 0,
    },
  });
  const station = (id, lat, lon, value) => ({
    ...GAVLE,
    id: `smhi:${id}`,
    stationId: id,
    name: id,
    lat,
    lon,
    value,
  });
  const layer = createAirQualityLayer({
    source: {
      getSnapshot: async () => [
        station('Gävle', 60.67, 17.14, 4),
        station('Piteå', 65.32, 21.48, 5),
        station('Göteborg', 57.7, 11.99, 2),
        station('Hidden', 60, 120, 6),
      ],
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(fake.viewer);
  layer.enable();
  await layer.update();
  assert.deepEqual(
    layer.getRowControls().list.items.map((item) => item.id),
    ['smhi:Gävle', 'smhi:Göteborg'],
  );
  layer.destroy();
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

/** A layer with clicks from a fake input and a fake pick registry. */
function clickHarness({ otherOwner = () => false } = {}) {
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const owners = new Map();
  const fake = fakeViewer();
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [GAVLE] },
    overlayHost: {
      setEntries(sourceId, entries, options) {
        if (sourceId === 'air-quality-card')
          state.cards.push({ entries, options });
      },
      setVisible() {},
      clearSource() {},
      hitTest: (x, y, options) => {
        state.hitTestOptions = options;
        return state.cardHit;
      },
    },
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 10, y: 10 },
            topHit: state.picked
              ? { set: 'air-quality:1', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking: {
      resolvePickId: (hit) => hit?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickId) => otherOwner(pickId),
      registerPickOwner: (id, predicate) => owners.set(id, predicate),
      unregisterPickOwner: (id) => owners.delete(id),
    },
  });
  layer.init(fake.viewer);
  return { layer, state, owners, viewer: fake.viewer };
}

test('clicking a station opens its card; empty ground closes it', async () => {
  const { layer, state, owners } = clickHarness();
  layer.enable();
  await layer.update();
  assert.ok(owners.get('air-quality')(`air-quality:${GAVLE.id}`));

  state.picked = `air-quality:${GAVLE.id}`;
  state.click();
  const opened = state.cards.at(-1);
  assert.equal(opened.entries[0].title, 'AIR QUALITY · GÄVLE STAKETGATAN');
  assert.ok(opened.entries[0].position, 'the card sits on the station');
  assert.deepEqual(opened.options, {
    cohortLimit: 1,
    collisionCapacity: 1,
    moving: false,
  });
  assert.deepEqual(state.hitTestOptions, { sourceId: 'air-quality-card' });

  state.picked = null;
  state.click();
  assert.deepEqual(state.cards.at(-1).entries, []);

  layer.disable();
  assert.equal(state.click, null, 'disable removes the click handler');
  assert.equal(owners.size, 0);
  layer.destroy();
});

test("a click on the open card, or on another layer's item, leaves the card", async () => {
  const { layer, state } = clickHarness({
    otherOwner: (pickId) => pickId.startsWith('se-hospital:'),
  });
  layer.enable();
  await layer.update();
  state.picked = `air-quality:${GAVLE.id}`;
  state.click();
  const writes = state.cards.length;

  // Its own card under the click is not the ground.
  state.cardHit = { entryId: `air-quality-card:${GAVLE.id}` };
  state.picked = null;
  state.click();
  assert.equal(state.cards.length, writes);

  // Another layer's item is not the ground either.
  state.cardHit = null;
  state.picked = 'se-hospital:1';
  state.click();
  assert.equal(state.cards.length, writes);

  // A card that is not this one's is looked through: the ground closes it.
  state.cardHit = { entryId: 'air-quality-card:other' };
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards.at(-1).entries, []);
  layer.destroy();
});

test('a busy pointer leaves clicks alone; no pick registry, no clicks', async () => {
  let listened = 0;
  const unpicked = createAirQualityLayer({
    source: { getSnapshot: async () => [GAVLE] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    input: () => ({
      onClick() {
        listened += 1;
        return () => {};
      },
    }),
  });
  unpicked.init(fakeViewer().viewer);
  unpicked.enable();
  assert.equal(
    listened,
    0,
    'without a pick registry the layer takes no clicks',
  );
  unpicked.destroy();

  let free = false;
  const cards = [];
  let click = null;
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [GAVLE] },
    overlayHost: {
      setEntries(sourceId, entries) {
        if (sourceId === 'air-quality-card') cards.push(entries);
      },
      setVisible() {},
      clearSource() {},
    },
    input: () => ({
      onClick(callback) {
        click = () =>
          callback({
            screenPosition: { x: 1, y: 1 },
            topHit: { set: 'air-quality:2', id: `air-quality:${GAVLE.id}` },
          });
        return () => {};
      },
    }),
    picking: {
      resolvePickId: (hit) => hit?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    pointer: { isPointerFree: () => free },
  });
  layer.init(fakeViewer().viewer);
  layer.enable();
  await layer.update();
  click();
  assert.equal(cards.length, 0, 'a tool holds the pointer');
  free = true;
  click();
  assert.equal(cards.at(-1).length, 1);
  layer.destroy();
});
