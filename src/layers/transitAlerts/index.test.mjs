// The disruption layer's life: no redraw for the same answer, cards with the
// newest alerts, failed drawings, a clean switch-off and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
  createTransitAlertsLayer,
} from './index.js';

const NOW = Date.parse('2026-11-10T17:00:00+01:00');
const PICK = 'se-trafikstorning:';

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

/** A layer on a fake viewer, fed by `feed.stops` (or failing on `feed.error`). */
function harness(t, stops = []) {
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
  const feed = { stops, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], click: null };
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
  const select = (id) => {
    viewer.picked = { id: `${PICK}${id}` };
    state.click({ position: { x: 10, y: 20 } });
  };
  return { layer, feed, clock, state, warn, entities, select };
}

test('the same answer draws nothing again, but the card reads the newest alerts', async (t) => {
  const { layer, feed, state, entities, select } = harness(t, [
    stop('a'),
    stop('b', { point: [17.9, 59.4] }),
  ]);
  layer.enable();
  await layer.update();
  const dot = entities.getById(`${PICK}a`);
  assert.ok(dot);
  select('a');
  const events = [];
  entities.collectionChanged.addEventListener(() => events.push('changed'));
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
  assert.deepEqual(events, []);
  assert.equal(entities.getById(`${PICK}a`), dot);
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
  assert.notEqual(entities.getById(`${PICK}a`), dot);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [stop('a'), stop('b')]);
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
    '[Data:TransitAlerts] Draw error:',
  );
  // The same answer next time: drawn all the same, error gone.
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
