// The SMHI weather layer's life: one set of dots shown while the layer is
// on, readings that come back, failed drawings, a clean switch-off, clicks
// and the forecast's own clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import { WIND_CLASSES, classOf } from '../seaWeather/records.js';
import { NO_READING_COLOR, temperatureColor } from '../roadWeather/records.js';
import {
  SMHI_WEATHER_OVERLAY_SOURCE_ID,
  createSmhiWeatherLayer,
} from './index.js';

const NOW = Date.parse('2026-11-04T22:00:00Z');
const MINUTE = 60_000;
const PICK = 'se-smhiobs:';
const SET_ID = 'smhi-weather';

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
function harness(t, stations = [], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer was given, so a test can make one of its writes fail.
  const made = [];
  const points = draw.points;
  draw.points = (spec) => {
    const set = points(spec);
    made.push(set);
    return set;
  };
  const feed = { stations, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), clicks: [], cardHit: null, forecasts: 0 };
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
      setEntries: (sourceId, entries) => state.shown.set(sourceId, entries),
      clearSource: (sourceId) => state.shown.delete(sourceId),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    // The globe's clicks: one listener per click handler installed.
    input: () => ({
      onClick(callback) {
        const handler = { callback, off: false };
        state.clicks.push(handler);
        return () => {
          handler.off = true;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    terrain,
    now: () => clock.now,
  });
  layer.init(viewer);
  const dots = () => draw.set(SET_ID);
  const items = () => [...(dots()?.items.values() ?? [])];
  const click = (pickId = null) =>
    state.clicks.at(-1).callback({
      screenPosition: { x: 10, y: 20 },
      topHit: pickId ? { set: SET_ID, id: pickId, surface: false } : null,
    });
  const cards = () => state.shown.get(SMHI_WEATHER_OVERLAY_SOURCE_ID);
  return {
    layer,
    feed,
    clock,
    state,
    warn,
    made,
    dots,
    items,
    click,
    cards,
  };
}

const windColors = (layer) =>
  layer.getRowControls().legend.map((item) => item.color);
const chip = (layer, id) =>
  layer.getRowControls().chips.find((entry) => entry.id === id);
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('the stations are one set of dots, shown only while the layer is on', async (t) => {
  const { layer, dots, items, state } = harness(t, [
    station('a'),
    station('b'),
  ]);
  assert.equal(dots().show, false);
  layer.enable();
  assert.equal(dots().show, true);
  assert.equal(await layer.update(), true);
  assert.equal(items().length, 2);
  layer.disable();
  assert.equal(dots().show, false);
  assert.equal(state.clicks[0].off, true);
  layer.destroy();
  assert.equal(dots(), undefined, 'the set is disposed');
});

test('a dot is coloured by air temperature or wind; one without a reading is small and grey', async (t) => {
  const { layer, items } = harness(t, [
    station('a'),
    station('b', { airTemp: null, wind: 15 }),
  ]);
  layer.enable();
  await layer.update();
  const [measured, grey] = items();
  assert.equal(measured.id, `${PICK}a`);
  assert.equal(measured.pixelSize, 10);
  assert.equal(measured.color, temperatureColor(3.9));
  assert.deepEqual(cssColor(measured.outlineColor), [1, 1, 1, 0.9]);
  assert.equal(measured.outlineWidth, 1.5);
  assert.equal(measured.height, 'clampGround');
  assert.deepEqual(measured.pos, { lon: 16.6, lat: 59.6, height: 0 });
  assert.equal(measured.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(grey.pixelSize, 6);
  assert.deepEqual(grey.color, [
    ...cssColor(NO_READING_COLOR).slice(0, 3),
    0.6,
  ]);
  // The WIND chip draws them again by mean wind.
  chip(layer, 'wind').onClick();
  const [calm, windy] = items();
  assert.equal(calm.color, classOf(WIND_CLASSES, 4.2).color);
  assert.equal(windy.color, classOf(WIND_CLASSES, 15).color);
  assert.equal(windy.pixelSize, 10);
  layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('a wind reading that comes back within the hour is shown', async (t) => {
  // The wind file failed: the same hour, the same temperature, no wind.
  const { layer, feed } = harness(t, [station('a', { wind: null })]);
  layer.enable();
  await layer.update();
  chip(layer, 'wind').onClick();
  assert.deepEqual(windColors(layer), []);
  // Ten minutes on the wind is back; nothing else changed.
  feed.stations = [station('a', { wind: 15 })];
  await layer.update();
  assert.deepEqual(windColors(layer), [classOf(WIND_CLASSES, 15).color]);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, made, items } = harness(t, [station('a'), station('b')]);
  layer.enable();
  t.mock.method(
    made[0],
    'set',
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
    items().map((item) => item.id),
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
  const { layer, clock, state, click } = harness(t, [station('a')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  click(`${PICK}a`);
  await settled();
  assert.equal(state.forecasts, 1);
  clock.now += 29 * MINUTE;
  click(`${PICK}a`);
  await settled();
  assert.equal(state.forecasts, 1, 'reused');
  clock.now += 2 * MINUTE;
  click(`${PICK}a`);
  await settled();
  assert.equal(state.forecasts, 2);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const { layer, click, cards } = harness(t, [station('a')]);
  layer.enable();
  await layer.update();
  click(`${PICK}a`);
  assert.deepEqual(
    cards().map((entry) => entry.id),
    ['smhi-weather-card:a'],
  );
  assert.ok(cards()[0].position, 'the card sits on the station');
  await settled();
  click(null);
  assert.deepEqual(cards(), []);
  layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const { layer, click, cards, state } = harness(t, [station('a')]);
  layer.enable();
  await layer.update();
  click(`${PICK}a`);
  await settled();
  const before = cards();
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  click(null);
  assert.equal(cards(), before, 'a card is not the ground');
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    click('se-hospital:1');
    assert.equal(cards(), before, "another layer's dot is not the ground");
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  layer.destroy();
});
