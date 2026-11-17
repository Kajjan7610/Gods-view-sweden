// The aurora layer's life: its band on the renderer's draw port, failed
// drawings, a clean switch-off, a row that names the forecast's time and
// follows the newest Kp, and a forecast too old to pass for the sky's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { AURORA_SOUTH, createAuroraLayer } from './index.js';

const NOW = Date.parse('2026-11-05T21:30:00Z');
const MINUTE = 60_000;

const rows = (chance = 0) =>
  Array.from({ length: 90 - AURORA_SOUTH + 1 }, () =>
    new Array(360).fill(chance),
  );
const snapshot = (extra = {}) => ({
  rows: rows(),
  observed: NOW - 8 * MINUTE,
  forecast: NOW + 30 * MINUTE,
  kp: { kp: 2.33, at: NOW - 210 * MINUTE },
  stale: false,
  fetchedAt: NOW,
  ...extra,
});

/**
 * The band is painted on a canvas; outside a browser a fake one will do,
 * which keeps the pixels put on it.
 */
function fakeCanvas(t) {
  const painted = [];
  const before = globalThis.document;
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0, pixels: null };
      canvas.getContext = () => ({
        createImageData: (width, height) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData(image) {
          canvas.pixels = image.data;
          painted.push(canvas);
        },
        drawImage(from) {
          canvas.pixels = from.pixels;
        },
      });
      return canvas;
    },
  };
  t.after(() => {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  });
  return painted;
}

function harness(t, first = snapshot()) {
  const painted = fakeCanvas(t);
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  let frames = 0;
  const { draw } = bindFakeDraw(viewer, {
    frame: { requestRender: () => (frames += 1), on: () => () => {} },
  });
  // The handle the layer holds, so a test can make it fail.
  const handles = {};
  const make = draw.shapes;
  draw.shapes = (spec) => (handles.shapes = make(spec));
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
  const band = () => draw.set('aurora');
  const oval = () => band()?.items.get('aurora-oval');
  const labels = () => layer.getRowControls().legend.map((item) => item.label);
  return {
    layer,
    feed,
    clock,
    warn,
    handles,
    band,
    oval,
    labels,
    painted,
    frames: () => frames,
  };
}

test('the band is one shape at aurora height, shown only while the layer is on', async (t) => {
  const { layer, band, oval } = harness(t);
  assert.equal(band().kind, 'shapes');
  assert.equal(band().show, false);
  layer.enable();
  assert.equal(band().show, true);
  await layer.update();
  const item = oval();
  assert.deepEqual(item.geometry, {
    kind: 'rectangle',
    rect: { west: -180, south: AURORA_SOUTH, east: 180, north: 90 },
    height: 110_000,
  });
  assert.equal(item.height, 'absolute');
  assert.equal(item.lit, true, 'lit by the scene, as the band always was');
  // The forecast as an image over the band, six pixels to a degree.
  const { canvas, key } = item.fill.image;
  assert.equal(canvas.width, 360 * 6);
  assert.equal(canvas.height, (90 - AURORA_SOUTH + 1) * 6);
  assert.equal(typeof key, 'string');
  layer.disable();
  assert.equal(band().show, false);
  layer.destroy();
  assert.equal(band(), undefined, 'the set is disposed');
});

test('the band is painted by chance: clear below 3 %, strongest at the heart', async (t) => {
  const grid = rows();
  // 90 N is the canvas's top row; 0 E is its middle column.
  grid.at(-1)[0] = 60;
  grid.at(-1)[1] = 2;
  const { layer, painted } = harness(t, snapshot({ rows: grid }));
  layer.enable();
  await layer.update();
  const pixels = painted.at(-1).pixels;
  const at = (x) => [...pixels.slice(x * 4, x * 4 + 4)];
  // #ff1744 at the cap of 0.75.
  assert.deepEqual(at(180), [255, 23, 68, Math.round(0.75 * 255)]);
  assert.deepEqual(at(181), [0, 0, 0, 0]);
});

test('a new forecast replaces the band’s image; the same one is left alone', async (t) => {
  const { layer, feed, band, oval, frames } = harness(t);
  layer.enable();
  await layer.update();
  const first = oval().fill.image;
  const writes = band().writes;
  const framesBefore = frames();

  // The same forecast with a new Kp: nothing drawn again.
  feed.snapshot = snapshot({ kp: { kp: 5, at: NOW } });
  await layer.update();
  assert.equal(band().writes, writes);
  assert.equal(oval().fill.image, first);

  // A new forecast: the same band, a new canvas under a new key.
  feed.snapshot = snapshot({ forecast: NOW + 40 * MINUTE, rows: rows(20) });
  await layer.update();
  assert.equal(band().writes, writes + 1);
  assert.equal(band().items.size, 1);
  const next = oval().fill.image;
  assert.notEqual(next.canvas, first.canvas);
  assert.notEqual(next.key, first.key);
  assert.ok(frames() > framesBefore, 'a frame is asked for');

  // A grid with no rows takes the band away.
  feed.snapshot = snapshot({ forecast: NOW + 50 * MINUTE, rows: [] });
  await layer.update();
  assert.equal(band().items.size, 0);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, handles, band } = harness(t);
  layer.enable();
  t.mock.method(
    handles.shapes,
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
    '[Data:Aurora] Draw error:',
  );
  // The same forecast ten minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(band().items.size, 1);
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
  const { layer, feed, band, labels } = harness(t);
  layer.enable();
  await layer.update();
  // 23:00 Swedish time; Kp from the three hours that began at 19:00.
  assert.deepEqual(labels().slice(0, 2), [
    'Forecast for 23:00',
    'Kp index 2.3 from 19:00 (0 calm, 9 extreme storm)',
  ]);
  // The same forecast with a new Kp: the band is left alone, the row is not.
  const writes = band().writes;
  feed.snapshot = snapshot({ kp: { kp: 5, at: NOW - 30 * MINUTE } });
  await layer.update();
  assert.equal(band().writes, writes);
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
  assert.equal(band().writes, writes + 2);
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
