// The road ferry layer's life: one set of dots shown while the layer is on,
// coloured by status, the next departure beside each, failed drawings, a
// clean switch-off and clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  IDLE_COLOR,
  MESSAGE_COLOR,
  ROAD_FERRIES_OVERLAY_SOURCE_ID,
  ROUTE_COLOR,
  createRoadFerriesLayer,
} from './index.js';

const NOW = Date.parse('2026-11-16T12:00:00+01:00');
const MINUTE = 60_000;
const LABELS = 'road-ferries-labels';
const SET_ID = 'road-ferries';

const route = (id, extra = {}) => ({
  id,
  name: `Route ${id}`,
  point: [11.7, 58.0],
  harbors: ['Here', 'There'],
  status: 'running',
  messages: [],
  departures: [{ at: NOW + 20 * MINUTE, from: 'Here', to: 'There', info: [] }],
  ...extra,
});

function harness(t, routes = [], { terrain = null } = {}) {
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
  const feed = { routes, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), clicks: [], cardHit: null };
  const layer = createRoadFerriesLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { routes: feed.routes, stale: false, fetchedAt: clock.now };
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
  const cards = () => state.shown.get(ROAD_FERRIES_OVERLAY_SOURCE_ID);
  const labels = () => state.shown.get(LABELS) ?? [];
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
    labels,
  };
}

test('the routes are one set of dots, shown only while the layer is on', async (t) => {
  const { layer, dots, items, state } = harness(t, [route('a'), route('b')]);
  assert.equal(dots().show, false);
  layer.enable();
  assert.equal(dots().show, true);
  assert.equal(await layer.update(), true);
  assert.equal(items().length, 2);
  assert.equal(layer.getStats().count, 2);
  layer.disable();
  assert.equal(dots().show, false);
  assert.equal(state.clicks[0].off, true);
  layer.destroy();
  assert.equal(dots(), undefined, 'the set is disposed');
});

test('a dot is coloured by status, idle routes drawn smaller', async (t) => {
  const { layer, items } = harness(t, [
    route('a'),
    route('b', { status: 'message', messages: ['Inställd tur'] }),
    route('c', { status: 'idle', departures: [] }),
  ]);
  layer.enable();
  await layer.update();
  const [running, message, idle] = items();
  assert.deepEqual(
    items().map((item) => item.id),
    ['se-ferry:a', 'se-ferry:b', 'se-ferry:c'],
  );
  assert.equal(running.color, ROUTE_COLOR);
  assert.equal(running.pixelSize, 12);
  assert.equal(running.outlineColor, '#ffffff');
  assert.equal(running.outlineWidth, 2);
  assert.equal(running.height, 'clampGround');
  assert.deepEqual(running.pos, { lon: 11.7, lat: 58.0, height: 0 });
  assert.equal(running.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(message.color, MESSAGE_COLOR);
  assert.equal(message.pixelSize, 12);
  assert.equal(idle.color, IDLE_COLOR);
  assert.equal(idle.pixelSize, 8);
  layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('the next departure is written beside each route that has one', async (t) => {
  const { layer, labels } = harness(t, [
    route('a'),
    route('c', { status: 'idle', departures: [] }),
  ]);
  layer.enable();
  await layer.update();
  assert.deepEqual(
    labels().map((entry) => entry.id),
    ['road-ferries-label:a'],
  );
  assert.ok(labels()[0].position, 'the label sits on the route');
  // The NEXT DEPARTURE chip takes the times away.
  layer
    .getRowControls()
    .chips.find(({ id }) => id === 'times')
    .onClick();
  assert.deepEqual(labels(), []);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, made, items } = harness(t, [route('a'), route('b')]);
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
    '[Data:RoadFerries] Draw error:',
  );
  // The same routes at the next refresh: drawn all the same, error gone.
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

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const { layer, click, cards } = harness(t, [route('a')]);
  layer.enable();
  await layer.update();
  click('se-ferry:a');
  assert.deepEqual(
    cards().map((entry) => entry.id),
    ['road-ferries-card:a'],
  );
  assert.ok(cards()[0].position, 'the card sits on the route');
  click(null);
  assert.deepEqual(cards(), []);
  layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const { layer, click, cards, state } = harness(t, [route('a')]);
  layer.enable();
  await layer.update();
  click('se-ferry:a');
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
