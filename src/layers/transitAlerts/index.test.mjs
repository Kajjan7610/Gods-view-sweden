// The disruption layer's life: its set of dots, no redraw for the same
// answer, cards with the newest alerts, failed drawings, a clean switch-off,
// its clock and its clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
  alertColor,
  createTransitAlertsLayer,
} from './index.js';

const NOW = Date.parse('2026-11-10T17:00:00+01:00');
const PICK = 'se-trafikstorning:';
const SET = 'transit-alerts';

const stop = (id, extra = {}) => ({
  id,
  name: `Hållplats ${id}`,
  point: [18.07, 59.33],
  operator: 'sl',
  operatorName: 'SL',
  kind: 'closed',
  alerts: [
    {
      id: `${id}-1`,
      kind: 'closed',
      header: 'Hållplatsen trafikeras inte',
      description: 'Vägarbete',
      endsAt: null,
    },
  ],
  ...extra,
});

/** A layer on a fake draw port, fed by `feed.stops` (or failing on `feed.error`). */
function harness(t, stops = [], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer holds, so a test can make a write fail.
  let handle = null;
  const points = draw.points;
  draw.points = (spec) => (handle = points(spec));
  const feed = { stops, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], cardHit: null, handlers: [] };
  let picked = null;
  const layer = createTransitAlertsLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stops: feed.stops,
          pending: [],
          stale: feed.stale,
          fetchedAt: feed.fetchedAt,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, TRANSIT_ALERTS_OVERLAY_SOURCE_ID);
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

test('the stops are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [stop('a')]);
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

test('a dot is coloured and sized by how serious its alerts are', async (t) => {
  const h = harness(t, [stop('a'), stop('b', { kind: 'moved' })]);
  h.layer.enable();
  await h.layer.update();
  const a = h.dot('a');
  assert.equal(a.color, alertColor('closed'));
  assert.equal(a.pixelSize, 11);
  assert.equal(h.dot('b').pixelSize, 9);
  assert.deepEqual(a.outlineColor, [0, 0, 0, 0.7]);
  assert.equal(a.outlineWidth, 1.5);
  assert.equal(a.height, 'clampGround');
  assert.deepEqual(a.pos, { lon: 18.07, lat: 59.33, height: 0 });
  assert.equal(a.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(a.scaleByDistance, {
    near: 2e4,
    nearValue: 1.4,
    far: 2e6,
    farValue: 0.6,
  });
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('the same answer draws nothing again, but the card reads the newest alerts', async (t) => {
  const { layer, feed, state, dots, dot, select } = harness(t, [
    stop('a'),
    stop('b', { point: [17.9, 59.4] }),
  ]);
  layer.enable();
  await layer.update();
  const drawn = dot('a');
  assert.ok(drawn);
  select('a');
  const writes = dots().writes;
  // The proxy answers the same rows (new objects) for a quarter of an hour;
  // here an alert's text has changed but no dot would look different.
  feed.stops = [
    stop('a', {
      alerts: [
        {
          id: 'a-1',
          kind: 'closed',
          header: 'Hållplatsen trafikeras inte',
          description: 'Vägarbete till 1 december',
          endsAt: null,
        },
      ],
    }),
    stop('b', { point: [17.9, 59.4] }),
  ];
  await layer.update();
  assert.equal(dots().writes, writes, 'nothing drawn again');
  assert.equal(dot('a'), drawn);
  assert.ok(
    state.cards[0].details.some((line) => line.includes('1 december')),
    'the card reads the new text',
  );
  // A stop whose kind changes is drawn again.
  feed.stops = [
    stop('a', { kind: 'moved' }),
    stop('b', { point: [17.9, 59.4] }),
  ];
  await layer.update();
  assert.notEqual(dot('a'), drawn);
  assert.equal(dot('a').color, alertColor('moved'));
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, markers, set } = harness(t, [stop('a'), stop('b')]);
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
    '[Data:TransitAlerts] Draw error:',
  );
  // The same answer next time: drawn all the same, error gone.
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
  const { layer, feed, clock } = harness(t, [stop('a')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  // A stale snapshot is as old as the read it came from.
  clock.now += 20 * 60_000;
  feed.stale = true;
  feed.fetchedAt = NOW + 60_000;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + 60_000);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const h = harness(t, [stop('a')]);
  h.layer.enable();
  await h.layer.update();
  h.select('a');
  assert.equal(h.state.cards.length, 1);
  assert.ok(h.state.cards[0].position, 'the card sits on the stop');
  h.click(null);
  assert.deepEqual(h.state.cards, []);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [stop('a')]);
  h.layer.enable();
  await h.layer.update();
  h.select('a');
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
