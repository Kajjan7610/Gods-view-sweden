// The SR traffic layer's life: cards read the newest rows, failed drawings,
// a clean switch-off and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SR_TRAFFIC_OVERLAY_SOURCE_ID, createSrTrafficLayer } from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;
const PICK = 'se-srtrafik:';

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

/** A layer on a fake viewer, fed by `feed.messages` (or failing on `feed.error`). */
function harness(t, messages = []) {
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
  const feed = { messages, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], click: null };
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

test('a card reads the newest text even when no dot would look different', async (t) => {
  const { layer, feed, state, entities, select } = harness(t, [
    message('1'),
    message('2', { point: [11.97, 57.71] }),
  ]);
  layer.enable();
  await layer.update();
  select('1');
  assert.ok(state.cards[0].details.includes('Ett körfält avstängt'));
  const dot = entities.getById(`${PICK}1`);
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
  assert.equal(entities.getById(`${PICK}1`), dot, 'the dot is left alone');
  layer.destroy();
});

test('a report that moves, changes priority or category is drawn again', async (t) => {
  const { layer, feed, entities } = harness(t, [message('1'), message('2')]);
  layer.enable();
  await layer.update();
  for (const change of [
    { point: [18.1, 59.4] },
    { priority: 1 },
    { category: 'transit' },
  ]) {
    const before = entities.getById(`${PICK}1`);
    feed.messages = [message('1', change), message('2')];
    await layer.update();
    assert.notEqual(entities.getById(`${PICK}1`), before, Object.keys(change));
  }
  // A planned report is hidden until asked for: recategorised, it leaves.
  feed.messages = [message('1', { category: 'planned' }), message('2')];
  await layer.update();
  assert.equal(entities.getById(`${PICK}1`), undefined);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [message('1'), message('2')]);
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
    '[Data:SrTraffic] Draw error:',
  );
  // The same reports at the next refresh: drawn all the same, error gone.
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
