// The SR traffic layer's life: its set of dots, cards read the newest rows,
// failed drawings, a clean switch-off, its clock and its clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  SR_TRAFFIC_OVERLAY_SOURCE_ID,
  createSrTrafficLayer,
  priorityColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;
const PICK = 'se-srtrafik:';
const SET = 'sr-traffic';

const message = (id, extra = {}) => ({
  id,
  point: [18.05, 59.33],
  priority: 3,
  category: 'road',
  kind: 'Trafikolycka',
  title: 'E4 Stockholm',
  location: 'Vid Norrtull',
  description: 'Ett körfält avstängt',
  created: NOW - 30 * MINUTE,
  ...extra,
});

/** A layer on a fake draw port, fed by `feed.messages` (or failing on `feed.error`). */
function harness(t, messages = [], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer holds, so a test can make a write fail.
  let handle = null;
  const points = draw.points;
  draw.points = (spec) => (handle = points(spec));
  const feed = { messages, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], cardHit: null, opened: [], handlers: [] };
  let picked = null;
  const layer = createSrTrafficLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          messages: feed.messages,
          stale: feed.stale,
          fetchedAt: feed.fetchedAt,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, SR_TRAFFIC_OVERLAY_SOURCE_ID);
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
  const dot = (id) => dots()?.items.get(`${PICK}${id}`);
  const markers = () => [...(dots()?.items.values() ?? [])];
  const click = (pickId) => {
    picked = pickId;
    state.handlers.at(-1).click();
  };
  const select = (id) => click(`${PICK}${id}`);
  return {
    layer,
    feed,
    clock,
    state,
    warn,
    dots,
    dot,
    markers,
    set: () => handle,
    click,
    select,
  };
}

test('the reports are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [message('1')]);
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

test('a dot is coloured and sized by priority, the serious ones on top', async (t) => {
  const h = harness(t, [message('1', { priority: 1 }), message('2')]);
  h.layer.enable();
  await h.layer.update();
  // Least serious first, so the serious ones are drawn on top.
  const [low, high] = h.markers();
  assert.equal(low.id, `${PICK}2`);
  assert.equal(high.id, `${PICK}1`);
  assert.equal(high.pixelSize, 16);
  assert.equal(high.color, priorityColor(1));
  assert.equal(high.outlineColor, '#ffffff');
  assert.equal(high.outlineWidth, 2.5);
  assert.equal(low.pixelSize, 10);
  assert.deepEqual(low.outlineColor, [0, 0, 0, 0.8]);
  assert.equal(low.outlineWidth, 1.5);
  assert.equal(high.height, 'clampGround');
  assert.deepEqual(high.pos, { lon: 18.05, lat: 59.33, height: 0 });
  assert.equal(high.disableDepthTest, Number.POSITIVE_INFINITY);
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('a card reads the newest text even when no dot would look different', async (t) => {
  const { layer, feed, state, dot, select } = harness(t, [
    message('1'),
    message('2', { point: [11.97, 57.71] }),
  ]);
  layer.enable();
  await layer.update();
  select('1');
  assert.ok(state.cards[0].details.includes('Ett körfält avstängt'));
  const drawn = dot('1');
  // SR rewrites the report; its id, priority and time stay the same.
  feed.messages = [
    message('1', {
      description: 'Vägen helt avstängd, omledning via Solna',
      location: 'Mellan Norrtull och Haga södra',
    }),
    message('2', { point: [11.97, 57.71] }),
  ];
  await layer.update();
  assert.ok(
    state.cards[0].details.includes('Vägen helt avstängd, omledning via Solna'),
  );
  assert.equal(state.cards[0].details[0], 'Mellan Norrtull och Haga södra');
  assert.equal(dot('1'), drawn, 'the dot is left alone');
  layer.destroy();
});

test('a report that moves, changes priority or category is drawn again', async (t) => {
  const { layer, feed, dot } = harness(t, [message('1'), message('2')]);
  layer.enable();
  await layer.update();
  for (const change of [
    { point: [18.1, 59.4] },
    { priority: 1 },
    { category: 'transit' },
  ]) {
    const before = dot('1');
    feed.messages = [message('1', change), message('2')];
    await layer.update();
    assert.notEqual(dot('1'), before, Object.keys(change));
  }
  // A planned report is hidden until asked for: recategorised, it leaves.
  feed.messages = [message('1', { category: 'planned' }), message('2')];
  await layer.update();
  assert.equal(dot('1'), undefined);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, markers, set } = harness(t, [
    message('1'),
    message('2'),
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
    '[Data:SrTraffic] Draw error:',
  );
  // The same reports at the next refresh: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(markers().length, 2);
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
  const { layer, feed, clock } = harness(t, [message('1')]);
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

test("a click on the selected card opens SR's traffic page; another card does not", async (t) => {
  const { layer, state, select, click } = harness(t, [message('1')]);
  layer.enable();
  await layer.update();
  select('1');
  const [card] = state.cards;
  assert.ok(card.position, 'the card sits on the report');
  assert.equal(card.details.at(-1), 'sverigesradio.se ↗ · click card to open');
  // Another layer's card under the pointer: not this one, nothing opens.
  state.cardHit = { sourceId: 'polisen-events', entryId: card.id };
  click(null);
  assert.deepEqual(state.opened, []);
  state.cardHit = { sourceId: SR_TRAFFIC_OVERLAY_SOURCE_ID, entryId: card.id };
  click(null);
  assert.deepEqual(state.opened, ['https://www.sverigesradio.se/trafik']);
  // The keyboard path does the same.
  assert.equal(card.activate(), true);
  assert.equal(state.opened.length, 2);
  // The ground lets go.
  state.cardHit = null;
  click(null);
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test("a click on another layer's dot leaves the open card alone", async (t) => {
  const h = harness(t, [message('1')]);
  h.layer.enable();
  await h.layer.update();
  h.select('1');
  const before = h.state.cards;
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
  const h = harness(
    t,
    [message('1'), message('2', { category: 'planned', point: [12, 57] })],
    { terrain },
  );
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(
    h.markers().map((item) => item.id),
    [`${PICK}1`],
  );
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  // The planned report is hidden: it has no dot to move.
  assert.deepEqual(
    h.markers().map((item) => item.id),
    [`${PICK}1`],
  );
  assert.equal(h.dot('1').pos.height, 250);
  h.layer.destroy();
});
