// The electricity price layer's life: its set of dots, the price now follows
// its clock, failed drawings, a clean switch-off and its clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  ELECTRICITY_OVERLAY_SOURCE_ID,
  createElectricityPricesLayer,
  priceColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const QUARTER = 15 * 60_000;
const PICK = 'se-elpris:';
const SET = 'electricity-prices';
const LABELS = 'electricity-price-labels';

/** A zone whose first quarter is cheap and second is dear. */
const zone = (id, extra = {}) => ({
  id,
  name: 'Stockholm',
  point: [16, 59.5],
  today: [
    { start: NOW, end: NOW + QUARTER, sek: 0.4, eur: 0.04 },
    { start: NOW + QUARTER, end: NOW + 2 * QUARTER, sek: 2.5, eur: 0.23 },
  ],
  tomorrow: [],
  ...extra,
});

function harness(t, zones = [], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer holds, so a test can make a write fail.
  let handle = null;
  const points = draw.points;
  draw.points = (spec) => (handle = points(spec));
  const feed = { zones, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), cardHit: null, handlers: [] };
  let picked = null;
  const layer = createElectricityPricesLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { zones: feed.zones, stale: false, fetchedAt: clock.now };
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
  const card = () => state.shown.get(ELECTRICITY_OVERLAY_SOURCE_ID)?.[0];
  const legendColors = () =>
    layer.getRowControls().legend.map((item) => item.color);
  const click = (pickId) => {
    picked = pickId;
    state.handlers.at(-1).click();
  };
  return {
    layer,
    feed,
    clock,
    state,
    warn,
    dots,
    markers,
    set: () => handle,
    card,
    legendColors,
    click,
  };
}

test('the zones are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [zone('SE3')]);
  assert.equal(h.dots().show, false);
  h.layer.enable();
  assert.equal(h.dots().show, true);
  await h.layer.update();
  assert.equal(h.markers().length, 1);
  assert.equal(h.state.shown.get(LABELS).length, 1, 'with its price label');
  assert.ok(h.state.shown.get(LABELS)[0].position);
  h.layer.disable();
  assert.equal(h.dots().show, false);
  assert.equal(h.state.handlers[0].destroyed, true);
  assert.equal(h.state.shown.has(LABELS), false, 'the labels go with it');
  h.layer.destroy();
  assert.equal(h.dots(), undefined, 'the set is disposed');
});

test('a dot is coloured by the price, with a white ring', async (t) => {
  const h = harness(t, [zone('SE3')]);
  h.layer.enable();
  await h.layer.update();
  const [dot] = h.markers();
  assert.equal(dot.id, `${PICK}SE3`);
  assert.equal(dot.color, priceColor(0.4));
  assert.equal(dot.pixelSize, 20);
  assert.equal(dot.outlineColor, '#ffffff');
  assert.equal(dot.outlineWidth, 3);
  assert.equal(dot.height, 'clampGround');
  assert.deepEqual(dot.pos, { lon: 16, lat: 59.5, height: 0 });
  assert.equal(dot.disableDepthTest, Number.POSITIVE_INFINITY);
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(t, [], { terrain }).dots().spec.clampTo, 'terrain');
});

test("the price now, its colour and the card follow the layer's own clock", async (t) => {
  const { layer, clock, markers, card, legendColors, click } = harness(t, [
    zone('SE3'),
  ]);
  layer.enable();
  await layer.update();
  const id = markers()[0].id;
  assert.ok(id.endsWith('SE3'), id);
  assert.deepEqual(legendColors(), [priceColor(0.4)]);
  click(id);
  assert.equal(card().accent, priceColor(0.4));
  assert.match(card().details[0], /0[.,]40/);
  assert.equal(layer.getStats().lastUpdate, NOW);
  // The next quarter-hour: dearer, with no new prices fetched.
  clock.now += QUARTER;
  await layer.update();
  assert.deepEqual(legendColors(), [priceColor(2.5)]);
  assert.equal(markers()[0].color, priceColor(2.5));
  assert.equal(card().accent, priceColor(2.5));
  assert.match(card().details[0], /2[.,]50/);
  // Past the last quarter there is no price now.
  clock.now += QUARTER;
  await layer.update();
  assert.deepEqual(legendColors(), []);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again a minute on', async (t) => {
  const { layer, warn, markers, set } = harness(t, [zone('SE3'), zone('SE4')]);
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
    '[Data:ElectricityPrices] Draw error:',
  );
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

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const h = harness(t, [zone('SE3')]);
  h.layer.enable();
  await h.layer.update();
  h.click(`${PICK}SE3`);
  assert.ok(h.card(), 'a card opens');
  assert.ok(h.card().position, 'the card sits on the zone');
  h.click(null);
  assert.equal(h.card(), undefined);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [zone('SE3')]);
  h.layer.enable();
  await h.layer.update();
  h.click(`${PICK}SE3`);
  const before = h.card();
  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(h.card(), before, 'a card is not the ground');
  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(h.card(), before, "another layer's dot is not the ground");
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  h.layer.destroy();
});

test('a story reads this quarter hour’s spot price per zone, in öre per kWh', async (t) => {
  const h = harness(t, [zone('SE1'), zone('SE4')]);
  assert.deepEqual(h.layer.storyFacts(), {});
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(h.layer.storyFacts(), { 'ore.SE1': 40, 'ore.SE4': 40 });
  h.clock.now = NOW + QUARTER;
  assert.deepEqual(h.layer.storyFacts(), { 'ore.SE1': 250, 'ore.SE4': 250 });
  // Past the day's last quarter there is no price to quote.
  h.clock.now = NOW + 3 * QUARTER;
  assert.deepEqual(h.layer.storyFacts(), {});
});
