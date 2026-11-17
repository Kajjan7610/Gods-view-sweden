// The police events layer's life: its set of dots, failed drawings, a clean
// switch-off, its clock and its clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  POLICE_OVERLAY_SOURCE_ID,
  categoryColor,
  createPolisenEventsLayer,
} from './index.js';
import { cssColor } from '../../render/color.js';

const NOW = Date.parse('2026-11-04T17:00:00Z');
const HOUR = 60 * 60_000;
const PICK = 'se-polisen:';
const SET = 'polisen-events';

const notice = (id, hoursAgo, extra = {}) => ({
  id,
  time: NOW - hoursAgo * HOUR,
  type: 'Trafikolycka',
  category: 'traffic',
  title: `4 november, Trafikolycka, Göteborg`,
  summary: null,
  place: 'Göteborg',
  county: 'Västra Götalands län',
  precision: 'municipality',
  point: [11.9675, 57.7075],
  link: null,
  ...extra,
});

/** A layer on a fake draw port, fed by `feed.events` (or failing on `feed.error`). */
function harness(t, events = [], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer holds, so a test can make a write fail.
  let handle = null;
  const points = draw.points;
  draw.points = (spec) => (handle = points(spec));
  const feed = { events, error: null };
  const clock = { now: NOW };
  const state = { cards: [], cardHit: null, opened: [], handlers: [] };
  let picked = null;
  const layer = createPolisenEventsLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { events: feed.events, stale: false, fetchedAt: clock.now };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, POLICE_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    openExternal: (url) => state.opened.push(url),
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 1, y: 1 },
              topHit: picked ? { set: SET, id: picked, surface: false } : null,
            }),
          destroyed: false,
        };
        state.handlers.push(handler);
        return () => {
          handler.destroyed = true;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    terrain,
    now: () => clock.now,
  });
  layer.init(viewer);
  const dots = () => draw.find(SET);
  const markers = () => [...(dots()?.items.values() ?? [])];
  const click = (pickId) => {
    picked = pickId;
    state.handlers.at(-1).click();
  };
  return {
    layer,
    feed,
    clock,
    warn,
    markers,
    dots,
    set: () => handle,
    state,
    click,
  };
}

const ids = (list) => list.map((marker) => marker.id.slice(PICK.length));

test('the notices are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [notice('a', 1)]);
  assert.equal(h.dots().show, false);
  h.layer.enable();
  assert.equal(h.dots().show, true);
  await h.layer.update();
  assert.equal(h.markers().length, 1);
  h.layer.disable();
  assert.equal(h.dots().show, false);
  assert.equal(h.state.handlers[0].destroyed, true);
  h.layer.destroy();
  assert.equal(h.dots(), undefined, 'the set is disposed');
});

test('a dot is coloured by category, dimmed with age and ringed by precision', async (t) => {
  const h = harness(t, [
    notice('new', 1),
    notice('old', 5, { category: 'fire', precision: 'county' }),
  ]);
  h.layer.enable();
  await h.layer.update();
  // Oldest first, so the newest dot of a place is drawn on top.
  const [old, fresh] = h.markers();
  assert.deepEqual(ids([old, fresh]), ['old', 'new']);
  const [r, g, b] = cssColor(categoryColor('traffic'));
  assert.deepEqual(fresh.color, [r, g, b, 1]);
  assert.equal(fresh.pixelSize, 10);
  assert.deepEqual(fresh.outlineColor, [0, 0, 0, 0.8]);
  assert.equal(fresh.outlineWidth, 1.5);
  const [fr, fg, fb] = cssColor(categoryColor('fire'));
  assert.deepEqual(old.color, [fr, fg, fb, 0.7]);
  assert.equal(old.pixelSize, 8);
  assert.deepEqual(old.outlineColor, [1, 1, 1, 0.85]);
  assert.equal(old.outlineWidth, 2);
  assert.equal(fresh.height, 'clampGround');
  assert.equal(fresh.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(fresh.pos.height, 0);
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, markers, set } = harness(t, [
    notice('a', 1),
    notice('b', 2),
  ]);
  layer.enable();
  t.mock.method(
    set(),
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
    '[Data:PolisenEvents] Draw error:',
  );
  // The same notices at the next refresh: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(ids(markers()), ['b', 'a']);
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

test("the time window and the bright dots follow the layer's own clock", async (t) => {
  const { layer, clock, markers } = harness(t, [
    notice('new', 1),
    notice('old', 30),
  ]);
  layer.enable();
  await layer.update();
  // Last 24 hours: the 30-hour-old notice is left out; a 1-hour-old one is bright.
  assert.deepEqual(ids(markers()), ['new']);
  assert.equal(markers()[0].pixelSize, 10);
  assert.equal(layer.getStats().lastUpdate, NOW);
  // Three hours on, the notice is no longer fresh.
  clock.now += 3 * HOUR;
  await layer.update();
  assert.equal(markers()[0].pixelSize, 8);
  assert.equal(layer.getStats().lastUpdate, NOW + 3 * HOUR);
  // A day on, it has left the window too.
  clock.now += 21 * HOUR;
  await layer.update();
  assert.deepEqual(ids(markers()), []);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().notices, 2);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const h = harness(t, [notice('a', 1, { link: 'https://polisen.se/x' })]);
  h.layer.enable();
  await h.layer.update();
  h.click(`${PICK}a`);
  assert.equal(h.state.cards.length, 1);
  assert.ok(h.state.cards[0].position, 'the card sits on the notice');
  // A click on the selected card opens the notice.
  h.state.cardHit = {
    sourceId: POLICE_OVERLAY_SOURCE_ID,
    entryId: h.state.cards[0].id,
  };
  h.click(null);
  assert.deepEqual(h.state.opened, ['https://polisen.se/x']);
  assert.equal(h.state.cards.length, 1, 'the card stays');
  h.state.cardHit = null;
  h.click(null);
  assert.deepEqual(h.state.cards, []);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [notice('a', 1)]);
  h.layer.enable();
  await h.layer.update();
  h.click(`${PICK}a`);
  const before = h.state.cards;
  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(h.state.cards, before, 'a card is not the ground');
  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(
      h.state.cards,
      before,
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  h.layer.destroy();
});

test('ground heights move the dots drawn, and only those', async (t) => {
  const terrain = {
    resolveEllipsoidalGround: async (points) =>
      points.map(() => ({ ellipsoid: 250, source: 'reearth' })),
  };
  const h = harness(t, [notice('new', 1), notice('old', 30)], { terrain });
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(ids(h.markers()), ['new']);
  assert.equal(h.markers()[0].pos.height, 0);
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  // The notice outside the window has no dot to move.
  assert.deepEqual(ids(h.markers()), ['new']);
  assert.equal(h.markers()[0].pos.height, 250);
  assert.equal(h.markers()[0].pixelSize, 10, 'it looks as it was drawn');
  h.layer.destroy();
});
