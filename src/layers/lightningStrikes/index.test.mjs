// The lightning layer's life: its set of dots, drawing in place, failed
// drawings, cards, heights and clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import {
  AGE_CLASSES,
  LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
  createLightningStrikesLayer,
} from './index.js';

const NOW = Date.parse('2026-07-10T15:00:00Z');
const MINUTE = 60_000;
const PICK = 'se-lightning:';
const SET = 'lightning-strikes';

const stroke = (id, minutesAgo, extra = {}) => ({
  id,
  point: [15.5, 58.4],
  at: NOW - minutesAgo * MINUTE,
  kind: 'ground-negative',
  amp: -12.3,
  sensors: 4,
  ...extra,
});

/** A layer on a fake draw port, fed by `feed.strikes` (or failing on `feed.error`). */
function harness(t, strikes = [], options = {}) {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The set the layer holds, each write it makes logged, so a test can see
  // what a round changed and make a write fail.
  let handle = null;
  const writes = [];
  const points = draw.points;
  draw.points = (spec) => {
    handle = points(spec);
    for (const method of ['set', 'upsert', 'remove']) {
      const write = handle[method];
      handle[method] = (list) => {
        write(list);
        writes.push({
          [method]: list.map((entry) =>
            (typeof entry === 'string' ? entry : entry.id).slice(PICK.length),
          ),
        });
      };
    }
    return handle;
  };
  const feed = { strikes, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const state = { cards: [], cardHit: null, handlers: [] };
  let picked = null;
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
    now: () => clock.now,
    ...options,
  });
  layer.init(viewer);
  const dots = () => draw.find(SET);
  const markers = () => [...(dots()?.items.values() ?? [])];
  const dot = (id) => dots()?.items.get(`${PICK}${id}`);
  const click = (pickId) => {
    picked = pickId;
    state.handlers.at(-1).click();
  };
  return {
    layer,
    feed,
    clock,
    state,
    log,
    warn,
    dots,
    markers,
    dot,
    writes,
    set: () => handle,
    click,
  };
}

const ids = (list) => list.map((marker) => marker.id.slice(PICK.length));
const classColor = (index) => AGE_CLASSES[index].color;
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('the strokes are one set of dots, shown only while the layer is on', async (t) => {
  const h = harness(t, [stroke('a', 1)]);
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

test('a ground stroke is a large dot, a cloud flash a small translucent one', async (t) => {
  const h = harness(t, [stroke('g', 1), stroke('c', 1, { kind: 'cloud' })]);
  h.layer.enable();
  await h.layer.update();
  const ground = h.dot('g');
  assert.equal(ground.pixelSize, 9);
  assert.equal(ground.color, classColor(0));
  assert.equal(ground.outlineColor, '#3a1600');
  assert.equal(ground.outlineWidth, 1.5);
  const cloud = h.dot('c');
  assert.equal(cloud.pixelSize, 6);
  const [r, g, b] = cssColor(classColor(0));
  assert.deepEqual(cloud.color, [r, g, b, 0.75]);
  assert.equal(cloud.outlineColor, '#5c3b00');
  assert.equal(cloud.outlineWidth, 1);
  assert.equal(ground.height, 'clampGround');
  assert.deepEqual(ground.pos, { lon: 15.5, lat: 58.4, height: 0 });
  assert.equal(ground.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(ground.scaleByDistance, {
    near: 2e4,
    nearValue: 1.3,
    far: 3e6,
    farValue: 0.7,
  });
  h.layer.destroy();
});

test('without the geoid the dots clamp to every surface; with it to terrain only', (t) => {
  assert.equal(harness(t).dots().spec.clampTo, 'both');
  const geoid = { ensureReady: () => Promise.resolve(), heightAt: () => 0 };
  assert.equal(harness(t, [], { geoid }).dots().spec.clampTo, 'terrain');
});

test('a new round changes the dots in place instead of drawing them all again', async (t) => {
  const { layer, feed, clock, markers, dot, writes } = harness(t, [
    stroke('a', 1),
    stroke('b', 4.5),
    stroke('d', 20),
    stroke('c', 59.5),
  ]);
  layer.enable();
  await layer.update();
  // Oldest first, so the newest strokes draw on top.
  assert.deepEqual(ids(markers()), ['c', 'd', 'b', 'a']);
  assert.deepEqual(writes, [{ set: ['c', 'd', 'b', 'a'] }]);
  const before = new Map(markers().map((marker) => [marker.id, marker]));
  assert.equal(dot('b').color, classColor(0));

  // A minute on: one new stroke, b is past five minutes and c past the hour.
  writes.length = 0;
  clock.now += MINUTE;
  feed.strikes = [stroke('n', -0.8), ...feed.strikes];
  await layer.update();
  assert.deepEqual(writes, [{ remove: ['c'] }, { upsert: ['b', 'n'] }]);
  assert.deepEqual(ids(markers()), ['d', 'b', 'a', 'n']);
  assert.equal(dot('a'), before.get(`${PICK}a`), 'left alone');
  assert.equal(dot('d'), before.get(`${PICK}d`), 'left alone');
  assert.equal(dot('b').color, classColor(1));
  assert.equal(dot('d').color, classColor(2));
  assert.equal(layer.getStats().count, 4);

  // A quiet minute where no stroke changes class touches nothing at all.
  writes.length = 0;
  clock.now += MINUTE;
  await layer.update();
  assert.deepEqual(writes, []);
  assert.deepEqual(ids(markers()), ['d', 'b', 'a', 'n']);
  layer.destroy();
});

test('a drawing that failed is reported and made again from scratch', async (t) => {
  const { layer, feed, clock, warn, markers, writes, set } = harness(t, [
    stroke('a', 1),
    stroke('b', 20),
  ]);
  layer.enable();
  const failOnce = (method) =>
    t.mock.method(
      set(),
      method,
      () => {
        throw new Error('no room');
      },
      { times: 1 },
    );
  // The first drawing fails: an error, not a quiet empty map.
  failOnce('set');
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:LightningStrikes] Draw error:',
  );
  // The same minute, the same strokes: drawn all the same.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(ids(markers()), ['b', 'a']);

  // A round in place that fails halfway is not trusted: the next starts over.
  clock.now += MINUTE;
  feed.strikes = [stroke('n', -0.5), ...feed.strikes];
  failOnce('upsert');
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  writes.length = 0;
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(writes, [{ set: ['b', 'a', 'n'] }], 'drawn again');
  assert.deepEqual(ids(markers()), ['b', 'a', 'n']);
  // And the round after that is in place again.
  writes.length = 0;
  clock.now += MINUTE;
  await layer.update();
  assert.ok(
    writes.every((write) => !write.set),
    'no drawing from scratch',
  );
  layer.destroy();
});

test('a selected stroke that passes the hour loses its card with its dot', async (t) => {
  const { layer, clock, state, markers, click } = harness(t, [
    stroke('a', 1),
    stroke('old', 59.5),
  ]);
  layer.enable();
  await layer.update();
  click(`${PICK}old`);
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['lightning-strikes-card:old'],
  );
  assert.ok(state.cards[0].position, 'the card sits on the stroke');
  clock.now += MINUTE;
  await layer.update();
  assert.deepEqual(ids(markers()), ['a']);
  assert.deepEqual(state.cards, []);
  // The stroke is still in the feed, but there is nothing left to select.
  click(`${PICK}old`);
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('a dot whose stroke passed the hour since the last round selects nothing', async (t) => {
  const { layer, clock, state, click } = harness(t, [stroke('old', 59.5)]);
  layer.enable();
  await layer.update();
  clock.now += MINUTE;
  click(`${PICK}old`);
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  const h = harness(t, [stroke('a', 1)]);
  h.layer.enable();
  await h.layer.update();
  h.click(`${PICK}a`);
  assert.equal(h.state.cards.length, 1);
  h.click(null);
  assert.deepEqual(h.state.cards, []);
  h.layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  const h = harness(t, [stroke('a', 1)]);
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
  let asked = 0;
  const { layer, warn, markers } = harness(
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
  assert.ok(markers().every((marker) => marker.pos.height === 0));
  // Turning the layer on again without a grid asks once more.
  layer.disable();
  layer.enable();
  await settled();
  assert.equal(asked, 2);
  assert.deepEqual(ids(markers()), ['b', 'a']);
  assert.ok(markers().every((marker) => marker.pos.height === 30));
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
