// The lightning layer's life: drawing in place, failed drawings, cards, heights.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  AGE_CLASSES,
  LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
  createLightningStrikesLayer,
} from './index.js';

const NOW = Date.parse('2026-07-10T15:00:00Z');
const MINUTE = 60_000;
const PICK = 'se-lightning:';

const stroke = (id, minutesAgo, extra = {}) => ({
  id,
  point: [15.5, 58.4],
  at: NOW - minutesAgo * MINUTE,
  kind: 'ground-negative',
  amp: -12.3,
  sensors: 4,
  ...extra,
});

function fakeViewer() {
  const viewer = {
    sources: [],
    picked: undefined,
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove: (source) =>
        viewer.sources.splice(viewer.sources.indexOf(source), 1),
    },
    scene: { pick: () => viewer.picked, requestRender() {} },
  };
  return viewer;
}

/** A layer on a fake viewer, fed by `feed.strikes` (or failing on `feed.error`). */
function harness(t, strikes = [], options = {}) {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = fakeViewer();
  const feed = { strikes, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], cardHit: null, click: null };
  const layer = createLightningStrikesLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          strikes: feed.strikes,
          stale: feed.stale,
          truncated: false,
          fetchedAt: feed.fetchedAt,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, LIGHTNING_STRIKES_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
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
    ...options,
  });
  layer.init(viewer);
  return { layer, viewer, feed, clock, state, log, warn };
}

const CLICK = { position: { x: 10, y: 20 } };
const entitiesOf = (viewer) => viewer.sources[0].entities;
const markers = (viewer) => entitiesOf(viewer).values;
const ids = (list) => list.map((marker) => marker.id.slice(PICK.length));
const colorOf = (marker) =>
  marker.point.color.getValue(Cesium.JulianDate.now());
const classColor = (index) =>
  Cesium.Color.fromCssColorString(AGE_CLASSES[index].color);
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a new round changes the dots in place instead of drawing them all again', async (t) => {
  const { layer, viewer, feed, clock } = harness(t, [
    stroke('a', 1),
    stroke('b', 4.5),
    stroke('d', 20),
    stroke('c', 59.5),
  ]);
  layer.enable();
  await layer.update();
  // Oldest first, so the newest strokes draw on top.
  assert.deepEqual(ids(markers(viewer)), ['c', 'd', 'b', 'a']);
  const before = new Map(markers(viewer).map((marker) => [marker.id, marker]));
  const colorOfA = before.get(`${PICK}a`).point.color;
  assert.ok(colorOf(before.get(`${PICK}b`)).equals(classColor(0)));

  const events = [];
  entitiesOf(viewer).collectionChanged.addEventListener(
    (collection, added, removed, changed) =>
      events.push({
        added: ids(added),
        removed: ids(removed),
        changed: ids(changed),
      }),
  );
  // A minute on: one new stroke, b is past five minutes and c past the hour.
  clock.now += MINUTE;
  feed.strikes = [stroke('n', -0.8), ...feed.strikes];
  await layer.update();
  assert.deepEqual(events, [{ added: ['n'], removed: ['c'], changed: ['b'] }]);
  assert.deepEqual(ids(markers(viewer)), ['d', 'b', 'a', 'n']);
  for (const marker of markers(viewer))
    if (marker.id !== `${PICK}n`)
      assert.equal(marker, before.get(marker.id), 'the same dot as before');
  assert.equal(before.get(`${PICK}a`).point.color, colorOfA, 'left alone');
  assert.ok(colorOf(before.get(`${PICK}b`)).equals(classColor(1)));
  assert.ok(colorOf(before.get(`${PICK}d`)).equals(classColor(2)));
  assert.equal(layer.getStats().count, 4);

  // A quiet minute where no stroke changes class touches nothing at all.
  clock.now += MINUTE;
  await layer.update();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(markers(viewer)), ['d', 'b', 'a', 'n']);
  layer.destroy();
});

test('a drawing that failed is reported and made again from scratch', async (t) => {
  const { layer, viewer, feed, clock, warn } = harness(t, [
    stroke('a', 1),
    stroke('b', 20),
  ]);
  layer.enable();
  const entities = entitiesOf(viewer);
  const failOnce = () =>
    t.mock.method(
      entities,
      'add',
      () => {
        throw new Error('no room');
      },
      { times: 1 },
    );
  // The first drawing fails: an error, not a quiet empty map.
  failOnce();
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:LightningStrikes] Draw error:',
  );
  // The same minute, the same strokes: drawn all the same.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(ids(markers(viewer)), ['b', 'a']);

  // A round in place that fails halfway is not trusted: the next starts over.
  const before = markers(viewer)[0];
  clock.now += MINUTE;
  feed.strikes = [stroke('n', -0.5), ...feed.strikes];
  failOnce();
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(ids(markers(viewer)), ['b', 'a', 'n']);
  assert.notEqual(markers(viewer)[0], before, 'drawn again, not kept');
  // And the round after that is in place again.
  clock.now += MINUTE;
  const kept = markers(viewer)[0];
  await layer.update();
  assert.equal(markers(viewer)[0], kept);
  layer.destroy();
});

test('a selected stroke that passes the hour loses its card with its dot', async (t) => {
  const { layer, viewer, clock, state } = harness(t, [
    stroke('a', 1),
    stroke('old', 59.5),
  ]);
  layer.enable();
  await layer.update();
  viewer.picked = { id: `${PICK}old` };
  state.click(CLICK);
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['lightning-strikes-card:old'],
  );
  clock.now += MINUTE;
  await layer.update();
  assert.deepEqual(ids(markers(viewer)), ['a']);
  assert.deepEqual(state.cards, []);
  // The stroke is still in the feed, but there is nothing left to select.
  state.click(CLICK);
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('a dot whose stroke passed the hour since the last round selects nothing', async (t) => {
  const { layer, viewer, clock, state } = harness(t, [stroke('old', 59.5)]);
  layer.enable();
  await layer.update();
  clock.now += MINUTE;
  viewer.picked = { id: `${PICK}old` };
  state.click(CLICK);
  assert.deepEqual(state.cards, []);
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

test('a geoid that did not load is asked for again, and then moves every dot', async (t) => {
  const heightOf = (marker) =>
    Cesium.Cartographic.fromCartesian(
      marker.position.getValue(Cesium.JulianDate.now()),
    ).height;
  let asked = 0;
  const { layer, viewer, warn } = harness(
    t,
    [stroke('a', 1), stroke('b', 20)],
    {
      geoid: {
        ensureReady: () =>
          ++asked === 1
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(),
        heightAt: () => 30,
      },
    },
  );
  layer.enable();
  await settled();
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:LightningStrikes] Geoid unavailable:',
  );
  await layer.update();
  assert.ok(
    markers(viewer).every((marker) => Math.abs(heightOf(marker)) < 0.01),
  );
  // Turning the layer on again without a grid asks once more.
  layer.disable();
  layer.enable();
  await settled();
  assert.equal(asked, 2);
  assert.deepEqual(ids(markers(viewer)), ['b', 'a']);
  assert.ok(
    markers(viewer).every((marker) => Math.abs(heightOf(marker) - 30) < 0.01),
  );
  // A grid that is loaded is not asked for a third time.
  layer.disable();
  layer.enable();
  await settled();
  assert.equal(asked, 2);
  layer.destroy();
});

test('the time of the last update follows the injected clock', async (t) => {
  const { layer, feed, clock } = harness(t, [stroke('a', 1)]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  // A stale snapshot is as old as the read it came from.
  clock.now += 3 * MINUTE;
  feed.stale = true;
  feed.fetchedAt = NOW + MINUTE;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + MINUTE);
  assert.equal(layer.getStats().stale, true);
  layer.destroy();
});
