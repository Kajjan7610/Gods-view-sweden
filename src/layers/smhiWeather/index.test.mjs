// The SMHI weather layer's life: readings that come back, failed drawings,
// a clean switch-off and the forecast's own clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WIND_CLASSES, classOf } from '../seaWeather/records.js';
import { createSmhiWeatherLayer } from './index.js';

const NOW = Date.parse('2026-11-04T22:00:00Z');
const MINUTE = 60_000;
const PICK = 'se-smhiobs:';

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [16.6, 59.6],
  airTemp: 3.9,
  wind: 4.2,
  gust: 7.1,
  precipitation: 0.2,
  updated: NOW - 30 * MINUTE,
  ...extra,
});

/** A layer on a fake viewer, fed by `feed.stations` (or failing on `feed.error`). */
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
  const state = { click: null, forecasts: 0 };
  const layer = createSmhiWeatherLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { stations: feed.stations, stale: false, fetchedAt: clock.now };
      },
      getForecast: async () => {
        state.forecasts += 1;
        return { next24: null, days: [] };
      },
    },
    overlayHost: {
      setEntries() {},
      clearSource() {},
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
  const entities = () => viewer.sources[0].entities;
  return { layer, viewer, feed, clock, state, warn, entities };
}

const windColors = (layer) =>
  layer.getRowControls().legend.map((item) => item.color);
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a wind reading that comes back within the hour is shown', async (t) => {
  // The wind file failed: the same hour, the same temperature, no wind.
  const { layer, feed } = harness(t, [station('a', { wind: null })]);
  layer.enable();
  await layer.update();
  layer
    .getRowControls()
    .chips.find(({ id }) => id === 'wind')
    .onClick();
  assert.deepEqual(windColors(layer), []);
  // Ten minutes on the wind is back; nothing else changed.
  feed.stations = [station('a', { wind: 15 })];
  await layer.update();
  assert.deepEqual(windColors(layer), [classOf(WIND_CLASSES, 15).color]);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [station('a'), station('b')]);
  layer.enable();
  t.mock.method(
    entities(),
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
    '[Data:SmhiWeather] Draw error:',
  );
  // The same readings at the next refresh: drawn all the same.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(
    entities().values.map((entity) => entity.id),
    [`${PICK}a`, `${PICK}b`],
  );
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

test("a station's forecast is asked for again after half an hour of the layer's clock", async (t) => {
  const { layer, viewer, clock, state } = harness(t, [station('a')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  viewer.picked = { id: `${PICK}a` };
  const click = { position: { x: 10, y: 20 } };
  state.click(click);
  await settled();
  assert.equal(state.forecasts, 1);
  clock.now += 29 * MINUTE;
  state.click(click);
  await settled();
  assert.equal(state.forecasts, 1, 'reused');
  clock.now += 2 * MINUTE;
  state.click(click);
  await settled();
  assert.equal(state.forecasts, 2);
  layer.destroy();
});
