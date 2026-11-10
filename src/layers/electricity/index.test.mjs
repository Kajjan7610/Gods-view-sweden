// The electricity price layer's life: the price now follows its clock, failed
// drawings and a clean switch-off.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELECTRICITY_OVERLAY_SOURCE_ID,
  createElectricityPricesLayer,
  priceColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const QUARTER = 15 * 60_000;

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

function harness(t, zones = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {
    sources: [],
    picked: undefined,
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove() {},
    },
    scene: { pick: () => viewer.picked, requestRender() {} },
  };
  const feed = { zones, error: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), click: null };
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
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const entities = viewer.sources[0].entities;
  const card = () => state.shown.get(ELECTRICITY_OVERLAY_SOURCE_ID)?.[0];
  const legendColors = () =>
    layer.getRowControls().legend.map((item) => item.color);
  return {
    layer,
    viewer,
    feed,
    clock,
    state,
    warn,
    entities,
    card,
    legendColors,
  };
}

test("the price now, its colour and the card follow the layer's own clock", async (t) => {
  const { layer, viewer, clock, state, entities, card, legendColors } = harness(
    t,
    [zone('SE3')],
  );
  layer.enable();
  await layer.update();
  const id = entities.values[0].id;
  assert.ok(id.endsWith('SE3'), id);
  assert.deepEqual(legendColors(), [priceColor(0.4)]);
  viewer.picked = { id };
  state.click({ position: { x: 10, y: 20 } });
  assert.equal(card().accent, priceColor(0.4));
  assert.match(card().details[0], /0[.,]40/);
  assert.equal(layer.getStats().lastUpdate, NOW);
  // The next quarter-hour: dearer, with no new prices fetched.
  clock.now += QUARTER;
  await layer.update();
  assert.deepEqual(legendColors(), [priceColor(2.5)]);
  assert.equal(card().accent, priceColor(2.5));
  assert.match(card().details[0], /2[.,]50/);
  // Past the last quarter there is no price now.
  clock.now += QUARTER;
  await layer.update();
  assert.deepEqual(legendColors(), []);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again a minute on', async (t) => {
  const { layer, warn, entities } = harness(t, [zone('SE3'), zone('SE4')]);
  layer.enable();
  t.mock.method(
    entities,
    'add',
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
  assert.equal(entities.values.length, 2);
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
