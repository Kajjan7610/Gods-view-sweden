// The radiation layer's life: its one set of dots, clicks, failed drawings,
// a clean switch-off, and a card that judges a reading's age by the layer's
// own clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  GAMMA_RADIATION_OVERLAY_SOURCE_ID,
  createGammaRadiationLayer,
  doseColor,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const HOUR = 3_600_000;
const LABELS = 'gamma-radiation-labels';

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [17.14, 60.67],
  value: 0.121,
  updated: NOW - HOUR,
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
  const feed = { stations, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), cardHit: null, picked: null };
  const handlers = [];
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
      hitTest: () => state.cardHit,
    },
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 10, y: 20 },
              topHit: state.picked
                ? { set: 'gamma-radiation', id: state.picked, surface: false }
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
    dots: () => draw.find('gamma-radiation'),
    items: () => [...(draw.find('gamma-radiation')?.items.values() ?? [])],
    card: () => state.shown.get(GAMMA_RADIATION_OVERLAY_SOURCE_ID)?.[0],
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

test('a dot is coloured by its dose rate; a silent station is small and see-through', async (t) => {
  const h = harness(t, [station('7'), station('8', { value: null })]);
  h.layer.enable();
  await h.layer.update();
  const [read, silent] = h.items();
  assert.equal(read.id, 'se-gamma:7');
  assert.equal(silent.id, 'se-gamma:8');
  assert.equal(read.pixelSize, 12);
  assert.equal(read.color, doseColor(0.121));
  assert.equal(silent.pixelSize, 7);
  assert.equal(silent.color, 'rgba(98, 98, 98, 0.7)');
  assert.equal(read.outlineColor, '#ffd600');
  assert.equal(read.outlineWidth, 2);
  assert.equal(read.height, 'clampGround');
  assert.deepEqual(read.pos, { lon: 17.14, lat: 60.67, height: 0 });
  assert.equal(read.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(read.scaleByDistance, undefined);
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test('the values are written beside the stations that have one, on the globe', async (t) => {
  const h = harness(t, [station('7'), station('8', { value: null })]);
  h.layer.enable();
  await h.layer.update();
  const labels = h.labels();
  assert.deepEqual(
    labels.map((entry) => entry.id),
    ['gamma-radiation-label:7'],
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
  h.click('se-gamma:7');
  assert.equal(h.card().id, 'gamma-radiation-card:7');
  assert.ok(h.card().position, 'the card sits on the station');
  h.click(null);
  assert.equal(h.card(), undefined);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [station('7')]);
  h.layer.enable();
  await h.layer.update();
  h.click('se-gamma:7');
  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(
    h.card()?.id,
    'gamma-radiation-card:7',
    'a card is not the ground',
  );
  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(
      h.card()?.id,
      'gamma-radiation-card:7',
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
    '[Data:GammaRadiation] Draw error:',
  );
  // The same readings ten minutes on: drawn all the same, error gone.
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
  assert.equal(
    h.card().details.at(-1),
    'Measured 14:00 · Strålsäkerhetsmyndigheten',
  );
  // The station goes silent; the next day the same reading carries its date.
  h.clock.now += 24 * HOUR;
  h.click(h.items()[0].id);
  assert.equal(
    h.card().details.at(-1),
    'Measured 2026-11-05 14:00 · Strålsäkerhetsmyndigheten',
  );
  h.layer.destroy();
});
