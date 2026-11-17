// The road weather layer's life: one set of dots shown while the layer is on,
// fading while the data stands still, ground heights that move only the dots
// drawn, failed drawings, a clean switch-off, clicks and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import {
  ICE_RISK_COLOR,
  ROAD_WEATHER_OVERLAY_SOURCE_ID,
  createTrafikverketWeatherLayer,
  temperatureColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;
const SET_ID = 'trafikverket-weather';

const station = (id, minutesAgo, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [18.04, 59.38],
  sampled: NOW - minutesAgo * MINUTE,
  surfaceTemp: -0.6,
  airTemp: 0.2,
  dewpoint: -1,
  humidity: 90,
  visibility: null,
  windSpeed: null,
  windDirection: null,
  windGust: null,
  precipitation: 'no',
  precipitation30: null,
  surfaceIce: null,
  surfaceSnow: null,
  surfaceWater: null,
  grip: null,
  risk: null,
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
  const feed = { stations, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { shown: new Map(), clicks: [], cardHit: null };
  const layer = createTrafikverketWeatherLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stations: feed.stations,
          stale: feed.stale,
          fetchedAt: feed.fetchedAt,
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
  const item = (id) => dots()?.items.get(`se-roadwx:${id}`);
  const click = (pickId = null) =>
    state.clicks.at(-1).callback({
      screenPosition: { x: 10, y: 20 },
      topHit: pickId ? { set: SET_ID, id: pickId, surface: false } : null,
    });
  const cards = () => state.shown.get(ROAD_WEATHER_OVERLAY_SOURCE_ID);
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
    item,
    click,
    cards,
    chip,
  };
}

const alphaOf = (color) => (typeof color === 'string' ? 1 : color[3]);

test('the stations are one set of dots, shown only while the layer is on', async (t) => {
  const { layer, dots, items, state } = harness(t, [
    station('a', 5),
    station('b', 5),
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

test('a dot is coloured by temperature, ringed white where the road risks ice', async (t) => {
  const { layer, item } = harness(t, [
    station('a', 5),
    station('b', 5, { risk: 'measured' }),
  ]);
  layer.enable();
  await layer.update();
  const plain = item('a');
  assert.equal(plain.color, temperatureColor(-0.6));
  assert.equal(plain.pixelSize, 9);
  assert.equal(plain.outlineColor, 'rgba(0, 0, 0, 0.75)');
  assert.deepEqual(cssColor(plain.outlineColor), [0, 0, 0, 0.75]);
  assert.equal(plain.outlineWidth, 1.5);
  assert.equal(plain.height, 'clampGround');
  assert.deepEqual(plain.pos, { lon: 18.04, lat: 59.38, height: 0 });
  assert.equal(plain.disableDepthTest, Number.POSITIVE_INFINITY);
  const ringed = item('b');
  assert.equal(ringed.pixelSize, 11);
  assert.equal(ringed.outlineColor, ICE_RISK_COLOR);
  assert.equal(ringed.outlineWidth, 3);
  // The air temperature colours the dots on the AIR chip.
  layer
    .getRowControls()
    .chips.find(({ id }) => id === 'air')
    .onClick();
  assert.equal(item('a').color, temperatureColor(0.2));
  layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('a station fades when it passes the hour, also while the data stands still', async (t) => {
  const { layer, feed, clock, dots, item } = harness(t, [
    station('a', 50),
    station('b', 5),
  ]);
  layer.enable();
  await layer.update();
  assert.equal(alphaOf(item('a').color), 1);
  // An outage: the proxy serves the same snapshot, a quarter of an hour on.
  clock.now += 15 * MINUTE;
  feed.stale = true;
  await layer.update();
  assert.equal(alphaOf(item('a').color), 0.45);
  assert.deepEqual(
    item('a').color.slice(0, 3),
    cssColor(temperatureColor(-0.6)).slice(0, 3),
  );
  assert.equal(alphaOf(item('b').color), 1);
  // Nothing passes the hour in the next minute: nothing is drawn again.
  const writes = dots().writes;
  clock.now += MINUTE;
  await layer.update();
  assert.equal(dots().writes, writes);
  layer.destroy();
});

test('ground heights move only the dots drawn, faded as they were drawn', async (t) => {
  // The heights answer when the test lets them.
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const terrain = {
    resolveEllipsoidalGround: async (points) => {
      await answered;
      return points.map(() => ({ ellipsoid: 42, source: 'reearth' }));
    },
  };
  const { layer, clock, item, items, chip } = harness(
    t,
    [
      station('a', 50, { point: [18.1, 59.1] }),
      station('b', 50, { risk: 'measured' }),
    ],
    { terrain },
  );
  layer.enable();
  // Only the stations with a risk of ice are drawn.
  chip('risk').onClick();
  clock.now += 15 * MINUTE;
  await layer.update();
  assert.deepEqual(
    items().map((entry) => entry.id),
    ['se-roadwx:b'],
  );
  assert.equal(alphaOf(item('b').color), 0.45);
  // A clock that reads otherwise now does not change the fade of a dot moved.
  clock.now = NOW;
  answer();
  for (let i = 0; i < 50 && item('b')?.pos.height !== 42; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(item('b').pos.height, 42);
  assert.equal(alphaOf(item('b').color), 0.45);
  assert.equal(item('a'), undefined, 'a station not drawn stays undrawn');
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, made, items } = harness(t, [
    station('a', 5),
    station('b', 5),
  ]);
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
    '[Data:TrafikverketWeather] Draw error:',
  );
  // The same readings at the next refresh: drawn all the same, error gone.
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

test('the time of the last update follows the injected clock', async (t) => {
  const { layer, feed, clock } = harness(t, [station('a', 5)]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  // A stale snapshot is as old as the read it came from.
  clock.now += 10 * MINUTE;
  feed.stale = true;
  feed.fetchedAt = NOW + MINUTE;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + MINUTE);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const { layer, click, cards } = harness(t, [station('a', 5)]);
  layer.enable();
  await layer.update();
  click('se-roadwx:a');
  assert.deepEqual(
    cards().map((entry) => entry.id),
    ['trafikverket-weather-card:a'],
  );
  assert.ok(cards()[0].position, 'the card sits on the station');
  click(null);
  assert.deepEqual(cards(), []);
  layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const { layer, click, cards, state } = harness(t, [station('a', 5)]);
  layer.enable();
  await layer.update();
  click('se-roadwx:a');
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
