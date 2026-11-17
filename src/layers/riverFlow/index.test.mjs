// The river flow layer's life: its one set of dots, clicks, failed drawings,
// a clean switch-off, a card that judges a reading's age by the layer's own
// clock, and readings too old to pass for the current flow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  RIVER_FLOW_OVERLAY_SOURCE_ID,
  createRiverFlowLayer,
  flowColor,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const HOUR = 3_600_000;
const LABELS = 'river-flow-labels';

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  river: 'Kalixälven',
  catchmentKm2: 120,
  point: [17.14, 60.67],
  flow: 12.5,
  change: 0,
  since: NOW - 105 * 60_000,
  updated: NOW - HOUR,
  quality: 'O',
  owner: 'SMHI',
  ...extra,
});

function harness(t, stations = [], options = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The handles the layer is given, so a test can make a drawing fail.
  const handles = [];
  const points = draw.points;
  draw.points = (spec) => {
    const handle = points(spec);
    handles.push(handle);
    return handle;
  };
  const feed = { stations, error: null, stale: false };
  const clock = { now: NOW };
  const state = { shown: new Map(), cardHit: null, picked: null };
  const handlers = [];
  const layer = createRiverFlowLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stations: feed.stations,
          stale: feed.stale,
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
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 10, y: 20 },
              topHit: state.picked
                ? { set: 'river-flow', id: state.picked, surface: false }
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
    now: () => clock.now,
    ...options,
  });
  layer.init(viewer);
  return {
    layer,
    feed,
    clock,
    state,
    warn,
    handlers,
    handle: () => handles[0],
    dots: () => draw.find('river-flow'),
    items: () => [...(draw.find('river-flow')?.items.values() ?? [])],
    card: () => state.shown.get(RIVER_FLOW_OVERLAY_SOURCE_ID)?.[0],
    labels: () => state.shown.get(LABELS) ?? [],
    click(pickId) {
      state.picked = pickId;
      handlers.at(-1).click();
    },
  };
}

test('the stations are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [station('7'), station('8')]);
  assert.equal(h.dots().show, false);
  h.layer.enable();
  assert.equal(h.dots().show, true);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.items().length, 2);
  assert.equal(h.layer.getStats().count, 2);
  h.layer.disable();
  assert.equal(h.dots().show, false);
  assert.equal(h.handlers[0].destroyed, true);
  h.layer.destroy();
  assert.equal(h.dots(), undefined, 'the set is disposed');
});

test('a dot is sized and coloured by its flow, in the order SMHI lists them', async (t) => {
  const h = harness(t, [
    station('7', { flow: 200 }),
    station('8', { flow: 0.4 }),
  ]);
  h.layer.enable();
  await h.layer.update();
  const [major, brook] = h.items();
  assert.equal(major.id, 'se-flow:7');
  assert.equal(brook.id, 'se-flow:8');
  assert.equal(major.pixelSize, 16);
  assert.equal(brook.pixelSize, 6);
  assert.equal(major.color, flowColor(200));
  assert.equal(brook.color, flowColor(0.4));
  assert.equal(major.outlineColor, 'rgba(255, 255, 255, 0.85)');
  assert.equal(major.outlineWidth, 1.5);
  assert.equal(major.height, 'clampGround');
  assert.deepEqual(major.pos, { lon: 17.14, lat: 60.67, height: 0 });
  assert.equal(major.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(major.scaleByDistance, undefined);
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('the flows are written beside the stations, on the globe', async (t) => {
  const h = harness(t, [station('7'), station('8')]);
  h.layer.enable();
  await h.layer.update();
  const labels = h.labels();
  assert.deepEqual(
    labels.map((entry) => entry.id),
    ['river-flow-label:7', 'river-flow-label:8'],
  );
  const { x, y, z } = labels[0].position;
  assert.ok([x, y, z].every(Number.isFinite), 'an ECEF position');
  assert.ok(Math.hypot(x, y, z) > 6e6);
  h.layer.getRowControls().chips[0].onClick();
  assert.equal(h.labels().length, 0, 'VALUES off writes none');
  h.layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const h = harness(t, [station('7')]);
  h.layer.enable();
  await h.layer.update();
  h.click('se-flow:7');
  assert.equal(h.card().id, 'river-flow-card:7');
  assert.ok(h.card().position, 'the card sits on the station');
  h.click(null);
  assert.equal(h.card(), undefined);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [station('7')]);
  h.layer.enable();
  await h.layer.update();
  h.click('se-flow:7');
  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(h.card()?.id, 'river-flow-card:7', 'a card is not the ground');
  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(
      h.card()?.id,
      'river-flow-card:7',
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  h.layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const h = harness(t, [station('7'), station('8')]);
  h.layer.enable();
  t.mock.method(
    h.handle(),
    'set',
    () => {
      throw new Error('no room');
    },
    { times: 1 },
  );
  await h.layer.update();
  assert.equal(h.layer.getStats().error, 'no room');
  assert.equal(
    h.warn.mock.calls.at(-1).arguments[0],
    '[Data:RiverFlow] Draw error:',
  );
  // The same readings a quarter on: drawn all the same, error gone.
  await h.layer.update();
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.items().length, 2);
  h.layer.destroy();
});

test('turning the layer off clears its error', async (t) => {
  const h = harness(t);
  h.layer.enable();
  h.feed.error = new Error('down');
  await h.layer.update();
  assert.equal(h.layer.getStats().error, 'down');
  h.layer.disable();
  assert.equal(h.layer.getStats().error, null);
  h.layer.destroy();
});

test("the card dates a reading by the layer's own clock", async (t) => {
  const h = harness(t, [station('7')]);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().lastUpdate, NOW);
  h.click(h.items()[0].id);
  // Measured an hour ago, today: the time alone.
  assert.equal(h.card().details.at(-1), 'Measured 14:00 · SMHI');
  // SMHI stops publishing; the next day the same reading carries its date.
  h.clock.now += 24 * HOUR;
  h.click(h.items()[0].id);
  assert.equal(h.card().details.at(-1), 'Measured 2026-11-05 14:00 · SMHI');
  h.layer.destroy();
});

test('readings over three hours old mark the layer stale', async (t) => {
  const h = harness(t, [
    station('7'),
    station('8', { updated: NOW - 5 * HOUR }),
  ]);
  h.layer.enable();
  await h.layer.update();
  // One station lags, the other is current: not stale.
  assert.equal(h.layer.getStats().stale, false);
  // The same file four hours later, served as if it were fresh.
  h.clock.now += 4 * HOUR;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, h.clock.now);
  // New values arrive: current again.
  h.feed.stations = [station('7', { updated: h.clock.now - HOUR })];
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  // The proxy's own word still counts.
  h.feed.stale = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  h.layer.destroy();
});
