// The sea weather layer's life: one set of dots shown while the layer is on,
// failed drawings, a clean switch-off, a card that follows the newest values
// and the layer's own clock, clicks, and water levels that are only compared
// when they share a zero.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import {
  NO_VALUE_COLOR,
  SEA_WEATHER_OVERLAY_SOURCE_ID,
  createSeaWeatherLayer,
  seaColor,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const HOUR = 3_600_000;
const LABELS = 'sea-weather-labels';
const SET_ID = 'sea-weather';

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [11.6 + Number(id) / 100, 57.63],
  level: -18,
  levelReference: 'MVY',
  waterTemp: 10.1,
  waveHeight: null,
  updated: NOW - HOUR,
  ...extra,
});

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
  const state = {
    shown: new Map(),
    clicks: [],
    picked: null,
    cardHit: null,
  };
  const layer = createSeaWeatherLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stations: feed.stations,
          stale: false,
          fetchedAt: clock.now,
        };
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
  const card = () => state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID)?.[0];
  const labels = () => state.shown.get(LABELS) ?? [];
  const chip = (id) =>
    layer.getRowControls().chips.find((entry) => entry.id === id);
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
    card,
    labels,
    chip,
  };
}

test('the stations are one set of dots, shown only while the layer is on', async (t) => {
  const { layer, dots, items, state } = harness(t, [
    station('7'),
    station('8'),
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

test('a dot is coloured by its level; one without a level against mean water is small and grey', async (t) => {
  const { layer, items } = harness(t, [
    station('7', { level: 12 }),
    station('8', { level: 48, levelReference: 'Sjökortsnivå' }),
  ]);
  layer.enable();
  await layer.update();
  const [measured, grey] = items();
  assert.equal(measured.id, 'se-sea:7');
  assert.equal(measured.pixelSize, 10);
  assert.equal(measured.color, seaColor(station('7', { level: 12 })));
  assert.equal(measured.outlineColor, '#0d47a1');
  assert.equal(measured.outlineWidth, 2);
  assert.equal(measured.height, 'clampGround');
  assert.deepEqual(measured.pos, { lon: 11.67, lat: 57.63, height: 0 });
  assert.equal(measured.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(grey.pixelSize, 6);
  assert.deepEqual(grey.color, [...cssColor(NO_VALUE_COLOR).slice(0, 3), 0.6]);
  layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, made, items } = harness(t, [station('7'), station('8')]);
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
    '[Data:SeaWeather] Draw error:',
  );
  // The same values ten minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(items().length, 2);
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

test('the open card follows the newest values without a new drawing', async (t) => {
  const { layer, feed, clock, dots, click, card } = harness(t, [station('7')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  click('se-sea:7');
  assert.deepEqual(card().details.slice(-2), [
    'Water +10.1 °C',
    'Measured 14:00 · SMHI',
  ]);
  // The level as before, a new water temperature and time: the dot is
  // left alone, the card reads the new row.
  const writes = dots().writes;
  clock.now += 10 * 60_000;
  feed.stations = [station('7', { waterTemp: 9.8, updated: clock.now })];
  await layer.update();
  assert.equal(dots().writes, writes);
  assert.deepEqual(card().details.slice(-2), [
    'Water +9.8 °C',
    'Measured 15:10 · SMHI',
  ]);
  // The station goes silent; the next day the reading carries its date.
  clock.now += 24 * HOUR;
  click('se-sea:7');
  assert.equal(card().details.at(-1), 'Measured 2026-11-05 15:10 · SMHI');
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const { layer, click, state } = harness(t, [station('7')]);
  layer.enable();
  await layer.update();
  click('se-sea:7');
  const opened = state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID);
  assert.deepEqual(
    opened.map((entry) => entry.id),
    ['sea-weather-card:7'],
  );
  assert.ok(opened[0].position, 'the card sits on the station');
  click(null);
  assert.deepEqual(state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID), []);
  layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const { layer, click, state } = harness(t, [station('7')]);
  layer.enable();
  await layer.update();
  click('se-sea:7');
  const before = state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID);
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  click(null);
  assert.equal(
    state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID),
    before,
    'a card is not the ground',
  );
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    click('se-hospital:1');
    assert.equal(
      state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID),
      before,
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  layer.destroy();
});

test('only levels against mean water are shown as such', async (t) => {
  const { layer, items, labels } = harness(t, [
    station('7', { level: 12 }),
    station('8', { level: 48, levelReference: 'Sjökortsnivå' }),
    station('9', { level: 74, levelReference: 'RH2000' }),
  ]);
  layer.enable();
  await layer.update();
  // Vänern's 48 cm above chart datum is neither labelled nor "very high".
  assert.deepEqual(
    labels().map((entry) => [entry.id, entry.title]),
    [['sea-weather-label:7', '+12 cm']],
  );
  assert.ok(labels()[0].position, 'the label sits on the station');
  assert.deepEqual(
    layer.getRowControls().legend.map((item) => item.count),
    [1],
  );
  const grey = items()
    .filter((item) => item.pixelSize === 6)
    .map((item) => item.id);
  assert.deepEqual(grey, ['se-sea:8', 'se-sea:9']);
  layer.destroy();
});

test('stations are coloured by water level and credit SMHI', async (t) => {
  const { layer, chip } = harness(t, [station('1'), station('2')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.source, 'SMHI');
  // Water level is the only quantity: no chip to choose it, VALUES stays.
  assert.deepEqual(
    layer.getRowControls().chips.map((entry) => entry.id),
    ['values'],
  );
  assert.equal(chip('values').active, true);
  assert.match(layer.getRowControls().legend[0].blurb, /SMHI’s ocean stations/);
  layer.destroy();
});
