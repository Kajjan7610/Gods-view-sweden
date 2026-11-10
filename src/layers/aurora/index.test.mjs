// The aurora layer's life: failed drawings, a clean switch-off, a row that
// names the forecast's time and follows the newest Kp, and a forecast too
// old to pass for the sky's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AURORA_SOUTH, createAuroraLayer } from './index.js';

const NOW = Date.parse('2026-11-05T21:30:00Z');
const MINUTE = 60_000;

const rows = () =>
  Array.from({ length: 90 - AURORA_SOUTH + 1 }, () => new Array(360).fill(0));
const snapshot = (extra = {}) => ({
  rows: rows(),
  observed: NOW - 8 * MINUTE,
  forecast: NOW + 30 * MINUTE,
  kp: { kp: 2.33, at: NOW - 210 * MINUTE },
  stale: false,
  fetchedAt: NOW,
  ...extra,
});

/** The band is painted on a canvas; outside a browser a blank one will do. */
function fakeCanvas(t) {
  const context = {
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData() {},
    drawImage() {},
  };
  const before = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  t.after(() => {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  });
}

function harness(t, first = snapshot()) {
  fakeCanvas(t);
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {
    sources: [],
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove() {},
    },
    scene: { requestRender() {} },
  };
  const feed = { snapshot: first, error: null };
  const clock = { now: NOW };
  const layer = createAuroraLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return feed.snapshot;
      },
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const entities = viewer.sources[0].entities;
  const labels = () => layer.getRowControls().legend.map((item) => item.label);
  return { layer, feed, clock, warn, entities, labels };
}

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t);
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
    '[Data:Aurora] Draw error:',
  );
  // The same forecast ten minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(entities.values.length, 1);
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

test('the row names the forecast’s time and follows a new Kp without a new drawing', async (t) => {
  const { layer, feed, entities, labels } = harness(t);
  layer.enable();
  await layer.update();
  // 23:00 Swedish time; Kp from the three hours that began at 19:00.
  assert.deepEqual(labels().slice(0, 2), [
    'Forecast for 23:00',
    'Kp index 2.3 from 19:00 (0 calm, 9 extreme storm)',
  ]);
  // The same forecast with a new Kp: the band is left alone, the row is not.
  const add = t.mock.method(entities, 'add');
  feed.snapshot = snapshot({ kp: { kp: 5, at: NOW - 30 * MINUTE } });
  await layer.update();
  assert.equal(add.mock.calls.length, 0);
  assert.equal(layer.getStats().kp, 5);
  assert.equal(labels()[1], 'Kp index 5 from 22:00 (0 calm, 9 extreme storm)');
  // A Kp without a time keeps the plain wording.
  feed.snapshot = snapshot({ kp: { kp: 4, at: null } });
  await layer.update();
  assert.equal(labels()[1], 'Kp index 4 (0 calm, 9 extreme storm)');
  // A grid that names no time at all is drawn every time.
  feed.snapshot = snapshot({ forecast: null, observed: null });
  await layer.update();
  await layer.update();
  assert.equal(add.mock.calls.length, 2);
  assert.deepEqual(labels().slice(0, 1), [
    'Kp index 2.3 from 19:00 (0 calm, 9 extreme storm)',
  ]);
  layer.destroy();
});

test('a forecast for a time over an hour past marks the layer stale', async (t) => {
  const { layer, feed, clock, labels } = harness(t);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, false);
  // NOAA keeps answering with the same file: an hour past its time is fine…
  clock.now = NOW + 90 * MINUTE;
  await layer.update();
  assert.equal(layer.getStats().stale, false);
  // …a minute more is not, and the row carries the date the next day.
  clock.now = NOW + 91 * MINUTE;
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  assert.equal(layer.getStats().lastUpdate, clock.now);
  clock.now = NOW + 24 * 60 * MINUTE;
  await layer.update();
  assert.equal(labels()[0], 'Forecast for 2026-11-05 23:00');
  // A new forecast: current again.
  feed.snapshot = snapshot({ forecast: clock.now + 30 * MINUTE });
  await layer.update();
  assert.equal(layer.getStats().stale, false);
  // The proxy's own word still counts.
  feed.snapshot = snapshot({ forecast: clock.now + 30 * MINUTE, stale: true });
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  layer.destroy();
});
