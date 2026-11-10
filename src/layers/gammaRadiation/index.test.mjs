// The radiation layer's life: failed drawings, a clean switch-off, and a card
// that judges a reading's age by the layer's own clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GAMMA_RADIATION_OVERLAY_SOURCE_ID,
  createGammaRadiationLayer,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const HOUR = 3_600_000;

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [17.14, 60.67],
  value: 0.121,
  updated: NOW - HOUR,
  ...extra,
});

function harness(t, stations = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {
    sources: [],
    picked: undefined,
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove() {},
    },
    scene: { pick: () => viewer.picked, requestRender() {} },
  };
  const feed = { stations, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), click: null };
  const layer = createGammaRadiationLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { stations: feed.stations, stale: false, fetchedAt: clock.now };
      },
    },
    overlayHost: {
      setEntries: (sourceId, entries) => state.shown.set(sourceId, entries),
      clearSource: (sourceId) => state.shown.delete(sourceId),
      setVisible() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const entities = viewer.sources[0].entities;
  const card = () => state.shown.get(GAMMA_RADIATION_OVERLAY_SOURCE_ID)?.[0];
  return { layer, viewer, feed, clock, state, warn, entities, card };
}

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [station('7'), station('8')]);
  layer.enable();
  t.mock.method(
    entities,
    'add',
    () => {
      throw new Error('no room');
    },
    { times: 1 },
  );
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:GammaRadiation] Draw error:',
  );
  // The same readings ten minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(entities.values.length, 2);
  layer.destroy();
});

test('turning the layer off clears its error', async (t) => {
  const { layer, feed } = harness(t);
  layer.enable();
  feed.error = new Error('down');
  await layer.update();
  assert.equal(layer.getStats().error, 'down');
  layer.disable();
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});

test("the card dates a reading by the layer's own clock", async (t) => {
  const { layer, viewer, clock, state, entities, card } = harness(t, [
    station('7'),
  ]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  viewer.picked = { id: entities.values[0].id };
  state.click({ position: { x: 10, y: 20 } });
  // Measured an hour ago, today: the time alone.
  assert.equal(
    card().details.at(-1),
    'Measured 14:00 · Strålsäkerhetsmyndigheten',
  );
  // The station goes silent; the next day the same reading carries its date.
  clock.now += 24 * HOUR;
  state.click({ position: { x: 10, y: 20 } });
  assert.equal(
    card().details.at(-1),
    'Measured 2026-11-05 14:00 · Strålsäkerhetsmyndigheten',
  );
  layer.destroy();
});
