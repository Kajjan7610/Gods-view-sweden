import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  clearGroundHeightStore,
  createGroundHeights,
} from '../groundHeights.js';
import { SHELTERS_OVERLAY_SOURCE_ID, createSheltersLayer } from './index.js';

const shelter = (id, lon, lat, distance) => ({
  id,
  point: [lon, lat],
  number: `1000${id}-7`,
  property: 'Sundin 20',
  places: 60,
  limited: false,
  special: false,
  distance,
});
const snapshot = (shelters) => ({
  stale: false,
  fetchedAt: Date.parse('2026-11-09T18:00:00Z'),
  count: 63364,
  tooWide: false,
  total: shelters.length,
  places: shelters.length * 60,
  shelters,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** A viewer low over Stockholm, as far as the layer looks at one. */
function fakeViewer({ view = [17.9, 59.2, 18.3, 59.5] } = {}) {
  const sources = [];
  return {
    sources,
    picked: undefined,
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(18.1, 59.33, 3000),
      computeViewRectangle: () => Cesium.Rectangle.fromDegrees(...view),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(18.1, 59.4),
      moveEnd: { addEventListener: () => () => {} },
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      pick() {
        return this.viewer.picked;
      },
      requestRender() {},
    },
  };
}

/** The layer with a card host and a click handler a test can drive. */
function harness(source, viewerOptions, options = {}) {
  const viewer = fakeViewer(viewerOptions);
  viewer.scene.viewer = viewer;
  const state = { cards: [], cardHit: null, click: null, notices: 0 };
  const layer = createSheltersLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, SHELTERS_OVERLAY_SOURCE_ID);
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
    ...options,
  });
  layer.init(viewer);
  layer.setRowControlsListener(() => state.notices++);
  return { layer, viewer, state };
}

test('a fetch the camera overtakes is no failure; one cut off by switching off is', async () => {
  const calls = [];
  const { layer, viewer } = harness({
    getSnapshot(query) {
      const call = { query, ...deferred() };
      calls.push(call);
      return call.promise;
    },
  });
  layer.enable();
  const first = layer.update();
  // The camera settles somewhere else before the first answer is back.
  const second = layer.update();
  assert.equal(calls[0].query.signal.aborted, true);
  calls[0].reject(new DOMException('Aborted', 'AbortError'));
  assert.equal(await first, true, 'the data manager keeps the layer on');
  calls[1].resolve(snapshot([shelter('1', 18.1, 59.4, 0)]));
  assert.equal(await second, true);
  assert.equal(viewer.sources[0].entities.values.length, 1);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);

  // Overtaken after the answer arrived, too.
  const third = layer.update();
  const fourth = layer.update();
  calls[2].resolve(snapshot([]));
  assert.equal(await third, true);
  assert.equal(layer.getStats().count, 1, 'the overtaken answer is not shown');

  layer.disable();
  calls[3].resolve(snapshot([]));
  assert.equal(await fourth, false);
  layer.destroy();
});

test('a tilted view asks for the box about the centre, not out to the horizon', async () => {
  const queries = [];
  const { layer } = harness(
    {
      async getSnapshot(query) {
        queries.push(query);
        return snapshot([]);
      },
    },
    { view: [14, 59, 24, 60.5] },
  );
  layer.enable();
  await layer.update();
  assert.deepEqual(queries[0].bbox, [16.6, 59, 19.6, 60.5]);
  assert.deepEqual(
    queries[0].center.map((value) => Math.round(value * 1e4) / 1e4),
    [18.1, 59.4],
  );
  layer.destroy();
});

test('a click on a card is not a click on the ground', async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([shelter('1', 18.1, 59.4, 0)]),
  });
  layer.enable();
  await layer.update();
  const click = { position: { x: 10, y: 20 } };
  const before = state.notices;

  viewer.picked = { id: 'se-shelter:1' };
  state.click(click);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].interactive, true, 'the card can be hit');
  assert.equal(state.notices, before + 1, 'the list marks the chosen shelter');

  // On the card: the dot under it is not picked and the ground not reached.
  viewer.picked = undefined;
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  state.click(click);
  assert.equal(state.cards.length, 1);

  state.cardHit = null;
  state.click(click);
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
  assert.equal(state.notices, before + 2);
  layer.destroy();
});

test('switched off, the layer keeps no dots or list and takes no selection', async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([shelter('1', 18.1, 59.4, 0)]),
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ shelterId: '1' }), true);
  assert.equal(state.cards.length, 1);

  layer.disable();
  assert.equal(state.cards.length, 0);
  assert.equal(viewer.sources[0].entities.values.length, 0);
  assert.equal(layer.setParams({ shelterId: '1', focus: true }), false);
  assert.equal(state.cards.length, 0);
  assert.equal(layer.getRowControls().list, undefined);
  assert.equal(layer.getStats().count, 63364, 'the register is still known');
  layer.destroy();
});

test("the dots are lifted where they are; their heights stay apart from the fixed layers'", async (t) => {
  clearGroundHeightStore();
  t.after(clearGroundHeightStore);
  const asked = [];
  const terrain = {
    resolveEllipsoidalGround: async (points) => {
      asked.push(points.length);
      return points.map(() => ({ ellipsoid: 25, source: 'reearth' }));
    },
  };
  const heightOf = (entity) =>
    Cesium.Cartographic.fromCartesian(
      entity.position.getValue(Cesium.JulianDate.now()),
    ).height;
  const { layer, viewer } = harness(
    {
      getSnapshot: async () =>
        snapshot([shelter('1', 18.1, 59.4, 0), shelter('2', 18.12, 59.41, 900)]),
    },
    undefined,
    { terrain },
  );
  layer.enable();
  await layer.update();
  const entities = viewer.sources[0].entities;
  const drawn = [...entities.values];
  assert.equal(drawn.length, 2);
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [2]);
  assert.deepEqual([...entities.values], drawn, 'the same dots are still there');
  assert.ok(drawn.every((entity) => Math.abs(heightOf(entity) - 25) < 0.01));

  // Another view of shelters finds the place kept; a fixed layer does not,
  // so a tour of the country cannot push the fixed layers' heights out.
  const passing = createGroundHeights(terrain, () => {}, { passing: true });
  await passing.place([{ id: 'again', point: [18.1, 59.4] }]);
  assert.equal(passing.isReal('again'), true);
  assert.deepEqual(asked, [2], 'nothing asked for a kept place');
  const fixed = createGroundHeights(terrain, () => {}, { gapMs: 0 });
  await fixed.place([{ id: 'station', point: [18.1, 59.4] }]);
  assert.deepEqual(asked, [2, 1]);
  layer.destroy();
});
