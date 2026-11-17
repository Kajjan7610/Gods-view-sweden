import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  clearGroundHeightStore,
  createGroundHeights,
} from '../groundHeights.js';
import {
  SHELTERS_MAX_HEIGHT_M,
  SHELTERS_OVERLAY_SOURCE_ID,
  createSheltersLayer,
  shelterColor,
} from './index.js';

const shelter = (id, lon, lat, distance, extra = {}) => ({
  id,
  point: [lon, lat],
  number: `1000${id}-7`,
  property: 'Sundin 20',
  places: 60,
  limited: false,
  special: false,
  distance,
  ...extra,
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

/**
 * The renderer's camera low over Stockholm, as far as the layer looks at
 * it: its pose, the rectangle in view, `moveEnd` and flights.
 */
function fakeCamera({ view = [17.9, 59.2, 18.3, 59.5], height = 3000 } = {}) {
  const [west, south, east, north] = view;
  const listeners = new Map();
  const camera = {
    height,
    flights: [],
    listeners,
    pose: () => ({ lon: 18.1, lat: 59.33, height: camera.height }),
    viewRectangle: () => ({ west, south, east, north }),
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(cb);
      return () => set.delete(cb);
    },
    flyTo(destination, options) {
      camera.flights.push({ destination, options });
      return { done: Promise.resolve('complete'), cancel() {} };
    },
  };
  return camera;
}

/** The layer with a card host and globe clicks a test can drive. */
function harness(source, viewerOptions, options = {}) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCamera(viewerOptions);
  const asked = [];
  const { draw } = bindFakeDraw(viewer, {
    camera,
    query: {
      pickEllipsoid(x, y) {
        asked.push([x, y]);
        return fromDegrees(18.1, 59.4);
      },
    },
  });
  const state = { cards: [], cardHit: null, notices: 0, picked: null };
  const handlers = [];
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
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 10, y: 20 },
              topHit: state.picked
                ? { set: 'shelters', id: state.picked, surface: false }
                : null,
            }),
          destroyed: false,
        };
        handlers.push(handler);
        return () => {
          handler.destroyed = true;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    ...options,
  });
  layer.init(viewer);
  layer.setRowControlsListener(() => state.notices++);
  return {
    layer,
    camera,
    asked,
    state,
    handlers,
    dots: () => draw.find('shelters'),
    items: () => [...(draw.find('shelters')?.items.values() ?? [])],
    click(pickId) {
      state.picked = pickId;
      handlers.at(-1).click();
    },
  };
}

test('the shelters are one set of dots, shown only while the layer is on', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([shelter('1', 18.1, 59.4, 0), shelter('2', 18.12, 59.41, 900)]),
  });
  assert.equal(h.dots().show, false);
  h.layer.enable();
  assert.equal(h.dots().show, true);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.items().length, 2);
  h.layer.disable();
  assert.equal(h.dots().show, false);
  assert.equal(h.handlers[0].destroyed, true);
  h.layer.destroy();
  assert.equal(h.dots(), undefined, 'the set is disposed');
});

test('a dot is sized by its places and coloured by its state, the nearest drawn last', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([
        shelter('1', 18.1, 59.4, 0, { places: 300 }),
        shelter('2', 18.12, 59.41, 900, { places: null, limited: true }),
      ]),
  });
  h.layer.enable();
  await h.layer.update();
  const [far, near] = h.items();
  assert.equal(far.id, 'se-shelter:2');
  assert.equal(near.id, 'se-shelter:1');
  assert.equal(near.pixelSize, 11);
  assert.equal(far.pixelSize, 6);
  assert.equal(near.color, shelterColor({ limited: false }));
  assert.equal(far.color, shelterColor({ limited: true }));
  assert.equal(near.outlineColor, '#0b1a1a');
  assert.equal(near.outlineWidth, 1.5);
  assert.equal(near.height, 'clampGround');
  assert.deepEqual(near.pos, { lon: 18.1, lat: 59.4, height: 0 });
  assert.equal(near.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(near.scaleByDistance, {
    near: 500,
    nearValue: 1.3,
    far: 40000,
    farValue: 0.7,
  });
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', () => {
  const source = { getSnapshot: async () => snapshot([]) };
  assert.equal(harness(source).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(
    harness(source, undefined, { terrain }).dots().spec.clampTo,
    'terrain',
  );
});

test('a fetch the camera overtakes is no failure; one cut off by switching off is', async () => {
  const calls = [];
  const h = harness({
    getSnapshot(query) {
      const call = { query, ...deferred() };
      calls.push(call);
      return call.promise;
    },
  });
  h.layer.enable();
  const first = h.layer.update();
  // The camera settles somewhere else before the first answer is back.
  const second = h.layer.update();
  assert.equal(calls[0].query.signal.aborted, true);
  calls[0].reject(new DOMException('Aborted', 'AbortError'));
  assert.equal(await first, true, 'the data manager keeps the layer on');
  calls[1].resolve(snapshot([shelter('1', 18.1, 59.4, 0)]));
  assert.equal(await second, true);
  assert.equal(h.items().length, 1);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().error, null);

  // Overtaken after the answer arrived, too.
  const third = h.layer.update();
  const fourth = h.layer.update();
  calls[2].resolve(snapshot([]));
  assert.equal(await third, true);
  assert.equal(
    h.layer.getStats().count,
    1,
    'the overtaken answer is not shown',
  );

  h.layer.disable();
  calls[3].resolve(snapshot([]));
  assert.equal(await fourth, false);
  h.layer.destroy();
});

test('a tilted view asks for the box about the centre, not out to the horizon', async () => {
  const queries = [];
  const h = harness(
    {
      async getSnapshot(query) {
        queries.push(query);
        return snapshot([]);
      },
    },
    { view: [14, 59, 24, 60.5] },
  );
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(h.asked, [[400, 300]], 'the ground under the canvas centre');
  assert.deepEqual(queries[0].bbox, [16.6, 59, 19.6, 60.5]);
  assert.deepEqual(
    queries[0].center.map((value) => Math.round(value * 1e4) / 1e4),
    [18.1, 59.4],
  );
  h.layer.destroy();
});

test('above the height limit nothing is asked, and the row says to zoom in', async () => {
  const queries = [];
  const h = harness(
    {
      async getSnapshot(query) {
        queries.push(query);
        return snapshot([shelter('1', 18.1, 59.4, 0)]);
      },
    },
    { height: SHELTERS_MAX_HEIGHT_M + 1 },
  );
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.deepEqual(queries, []);
  assert.equal(h.items().length, 0);
  assert.match(h.layer.getRowControls().info, /Zoom in/);
  h.layer.destroy();
});

test("the camera's move end asks again only while the layer is on", () => {
  const h = harness({ getSnapshot: async () => snapshot([]) });
  const moveEnd = () => h.camera.listeners.get('moveEnd')?.size ?? 0;
  assert.equal(moveEnd(), 0);
  h.layer.enable();
  assert.equal(moveEnd(), 1);
  h.layer.disable();
  assert.equal(moveEnd(), 0);
  h.layer.destroy();
});

test('a shelter picked from the list is selected and flown to', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([shelter('1', 18.1, 59.4, 0)]),
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.setParams({ shelterId: '1', focus: true }), true);
  assert.equal(h.state.cards[0]?.id, 'shelters-card:1');
  assert.equal(h.camera.flights.length, 1);
  const [{ destination, options }] = h.camera.flights;
  assert.equal(destination.lon, 18.1);
  assert.ok(Math.abs(destination.lat - 59.394) < 1e-9);
  assert.equal(destination.height, 650);
  assert.equal(options.durationS, 1.6);
  assert.deepEqual(options.orientation, {
    heading: 0,
    pitch: (-50 * Math.PI) / 180,
    roll: 0,
  });
  assert.equal(h.layer.setParams({ shelterId: '1' }), true);
  assert.equal(h.camera.flights.length, 1, 'no flight without focus');
  h.layer.destroy();
});

test('a click on a card is not a click on the ground', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([shelter('1', 18.1, 59.4, 0)]),
  });
  h.layer.enable();
  await h.layer.update();
  const before = h.state.notices;

  h.click('se-shelter:1');
  assert.equal(h.state.cards.length, 1);
  assert.equal(h.state.cards[0].interactive, true, 'the card can be hit');
  assert.ok(h.state.cards[0].position, 'the card sits on the shelter');
  assert.equal(
    h.state.notices,
    before + 1,
    'the list marks the chosen shelter',
  );

  // On the card: the dot under it is not picked and the ground not reached.
  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(h.state.cards.length, 1);

  // Another layer's dot is not the ground either.
  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(h.state.cards.length, 1);
  } finally {
    picking.unregisterPickOwner('hospitals');
  }

  h.click(null);
  assert.equal(h.state.cards.length, 0, 'a click on the ground lets go');
  assert.equal(h.state.notices, before + 2);
  h.layer.destroy();
});

test('switched off, the layer keeps no dots or list and takes no selection', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([shelter('1', 18.1, 59.4, 0)]),
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.setParams({ shelterId: '1' }), true);
  assert.equal(h.state.cards.length, 1);

  h.layer.disable();
  assert.equal(h.state.cards.length, 0);
  assert.equal(h.items().length, 0);
  assert.equal(h.layer.setParams({ shelterId: '1', focus: true }), false);
  assert.equal(h.state.cards.length, 0);
  assert.equal(h.layer.getRowControls().list, undefined);
  assert.equal(h.layer.getStats().count, 63364, 'the register is still known');
  h.layer.destroy();
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
  const h = harness(
    {
      getSnapshot: async () =>
        snapshot([
          shelter('1', 18.1, 59.4, 0),
          shelter('2', 18.12, 59.41, 900),
        ]),
    },
    undefined,
    { terrain },
  );
  h.layer.enable();
  await h.layer.update();
  const ids = h.items().map((item) => item.id);
  assert.equal(ids.length, 2);
  assert.equal(h.dots().writes, 1);
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [2]);
  assert.deepEqual(
    h.items().map((item) => item.id),
    ids,
    'the same dots are still there',
  );
  assert.ok(h.items().every((item) => item.pos.height === 25));
  assert.equal(h.dots().writes, 2, 'moved, not drawn again');

  // Another view of shelters finds the place kept; a fixed layer does not,
  // so a tour of the country cannot push the fixed layers' heights out.
  const passing = createGroundHeights(terrain, () => {}, { passing: true });
  await passing.place([{ id: 'again', point: [18.1, 59.4] }]);
  assert.equal(passing.isReal('again'), true);
  assert.deepEqual(asked, [2], 'nothing asked for a kept place');
  const fixed = createGroundHeights(terrain, () => {}, { gapMs: 0 });
  await fixed.place([{ id: 'station', point: [18.1, 59.4] }]);
  assert.deepEqual(asked, [2, 1]);
  h.layer.destroy();
});
