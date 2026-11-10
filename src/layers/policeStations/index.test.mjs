import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { clearGroundHeightStore } from '../groundHeights.js';
import {
  POLICE_STATIONS_OVERLAY_SOURCE_ID,
  createPoliceStationsLayer,
} from './index.js';

const station = (id, extra = {}) => ({
  id,
  point: [18.04, 59.33],
  name: `Station ${id}`,
  address: 'Storgatan 1',
  url: `https://polisen.se/om-polisen/kontakt/polisstationer/x/${id}/`,
  services: ['report'],
  ...extra,
});
const snapshot = (stations) => ({
  stale: false,
  fetchedAt: Date.parse('2026-11-09T18:00:00Z'),
  stations,
});

/** A viewer, as far as the layer looks at one. */
function fakeViewer() {
  const sources = [];
  const viewer = {
    sources,
    picked: undefined,
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
    scene: {
      pick: () => viewer.picked,
      requestRender() {},
    },
  };
  return viewer;
}

/** The layer with a card host and a click handler a test can drive. */
function harness(source, options = {}) {
  const viewer = fakeViewer();
  const state = { cards: [], cardHit: null, click: null, opened: [] };
  const layer = createPoliceStationsLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, POLICE_STATIONS_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    openExternal: (url) => state.opened.push(url),
    ...options,
  });
  layer.init(viewer);
  return { layer, viewer, state };
}

const CLICK = { position: { x: 10, y: 20 } };

test('a click on a station shows its card, and a click on the card its page', async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(viewer.sources[0].entities.values.length, 2);

  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  assert.equal(state.cards.length, 1);
  const [card] = state.cards;
  assert.equal(card.id, 'police-stations-card:1');
  assert.equal(typeof card.activate, 'function');

  // On the card: the page opens, and the dot under the card is not picked.
  viewer.picked = { id: 'se-police-station:2' };
  state.cardHit = { sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID, entryId: card.id };
  state.click(CLICK);
  assert.deepEqual(state.opened, [station('1').url]);
  assert.equal(state.cards[0].id, card.id, 'the selection stays');

  state.cardHit = null;
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
  layer.destroy();
});

test("a click on another layer's card is not a click on the ground", async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'police-stations-card:1', 'still selected');
  viewer.picked = { id: 'se-police-station:2' };
  state.click(CLICK);
  assert.equal(
    state.cards[0]?.id,
    'police-stations-card:1',
    'the station behind the card is not selected',
  );
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('without a way to open pages the card is still hit, and opens nothing', async () => {
  const { layer, viewer, state } = harness(
    { getSnapshot: async () => snapshot([station('1')]) },
    { openExternal: null },
  );
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);

  viewer.picked = undefined;
  state.cardHit = { sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID, entryId: card.id };
  state.click(CLICK);
  assert.equal(state.cards.length, 1, 'the selection stays');
  layer.destroy();
});

test('a station that changes name, address or page is drawn again', async () => {
  let rows = [station('1')];
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot(rows),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  assert.ok(state.cards[0].details.includes('Storgatan 1'));

  rows = [station('1', { address: 'Nygatan 2' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Nygatan 2'));

  rows = [station('1', { address: 'Nygatan 2', name: 'Nya stationen' })];
  await layer.update();
  assert.match(state.cards[0].title, /NYA STATIONEN/);

  rows = [station('1', { address: 'Nygatan 2', name: 'Nya stationen', url: null })];
  await layer.update();
  assert.equal(state.cards[0].activate, undefined, 'no page left to open');
  layer.destroy();
});

const heightOf = (entity) =>
  Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

/** Terrain that answers 40 m everywhere, and counts what it was asked. */
function fakeTerrain() {
  const asked = [];
  return {
    asked,
    resolveEllipsoidalGround: async (points) => {
      asked.push(points.length);
      return points.map(() => ({ ellipsoid: 40, source: 'reearth' }));
    },
  };
}

const settled = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test('ground heights lift the dots where they are; a browser that kept them asks nothing', async (t) => {
  clearGroundHeightStore();
  t.after(clearGroundHeightStore);
  const rows = [
    station('1'),
    station('2', { point: [11.97, 57.71] }),
    station('3', { point: [13.0, 55.6] }),
  ];
  const source = { getSnapshot: async () => snapshot(rows) };

  const terrain = fakeTerrain();
  const first = harness(source, { terrain });
  first.layer.enable();
  const entities = first.viewer.sources[0].entities;
  const changes = [];
  entities.collectionChanged.addEventListener((_, added, removed, changed) =>
    changes.push([added.length, removed.length, changed.length]),
  );
  await first.layer.update();
  const drawn = [...entities.values];
  assert.deepEqual(changes, [[3, 0, 0]], 'drawn once, before any answer');
  assert.ok(drawn.every((entity) => Math.abs(heightOf(entity)) < 0.01));

  await settled();
  assert.deepEqual(terrain.asked, [3], 'one request for the three places');
  assert.deepEqual(
    [...entities.values],
    drawn,
    'the same dots are still there',
  );
  assert.ok(drawn.every((entity) => Math.abs(heightOf(entity) - 40) < 0.01));
  assert.deepEqual(changes.at(-1), [0, 0, 3], 'moved, not drawn again');
  assert.equal(changes.length, 2);
  first.layer.destroy();

  // The next visit: the heights are in the first drawing, nothing is asked.
  const again = fakeTerrain();
  const second = harness(source, { terrain: again });
  second.layer.enable();
  const redrawn = [];
  second.viewer.sources[0].entities.collectionChanged.addEventListener(
    (_, added, removed, changed) =>
      redrawn.push([added.length, removed.length, changed.length]),
  );
  await second.layer.update();
  await settled();
  assert.deepEqual(redrawn, [[3, 0, 0]], 'one drawing, no lift after it');
  assert.ok(
    second.viewer.sources[0].entities.values.every(
      (entity) => Math.abs(heightOf(entity) - 40) < 0.01,
    ),
  );
  assert.deepEqual(again.asked, []);
  second.layer.destroy();
});
