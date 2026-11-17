// The speed camera layer: arrows and dots, the card, and what a bad round leaves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  SPEED_CAMERAS_OVERLAY_SOURCE_ID,
  createSpeedCamerasLayer,
} from './index.js';

// The markers are drawn on a canvas; here one that only notes what was drawn.
const drawing = { failNext: false };
const realDocument = globalThis.document;
globalThis.document = {
  createElement() {
    if (drawing.failNext) {
      drawing.failNext = false;
      throw new Error('no canvas');
    }
    const calls = [];
    const note =
      (name) =>
      (...args) =>
        calls.push([name, ...args]);
    return {
      width: 0,
      height: 0,
      calls,
      getContext: () => ({
        beginPath: note('beginPath'),
        arc: note('arc'),
        fill: note('fill'),
        stroke: note('stroke'),
        moveTo: note('moveTo'),
        lineTo: note('lineTo'),
        closePath: note('closePath'),
      }),
    };
  },
};
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const site = (over = {}) => ({
  id: '1',
  name: 'Rotebro',
  road: 'E4',
  bearing: 90,
  county: 'Stockholms län',
  point: [17.9, 59.47],
  ...over,
});

/** The eye straight above the site, `heightM` up. */
const eyeAt = (heightM) => ({
  height: heightM,
  position: fromDegrees(17.9, 59.47, heightM),
});

/** A layer on a fake renderer, fed by `feed.cameras` (or failing on `feed.error`). */
function harness(t, cameras = [site()], { terrain = null } = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const camera = fakeCameraPort({ pose: eyeAt(2_000) });
  const { draw } = bindFakeDraw(viewer, { camera: camera.port });
  const feed = { cameras, error: null };
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const layer = createSpeedCamerasLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { cameras: feed.cameras, stale: false, fetchedAt: 0 };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, SPEED_CAMERAS_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 10, y: 20 },
            topHit: state.picked
              ? { set: 'speed-cameras', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
    terrain,
  });
  layer.init(viewer);
  const markers = () => [...(draw.find('speed-cameras')?.items.values() ?? [])];
  return { layer, draw, camera, feed, state, markers };
}

// First: the markers are drawn once and kept, so only the first round of
// this file can meet a canvas that fails.
test('a drawing that failed is made again on the next round', async (t) => {
  const { layer, markers } = harness(t);
  layer.enable();
  drawing.failNext = true;
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'no canvas');
  assert.equal(markers().length, 0);

  // The same answer again: it was never drawn, so it is drawn now.
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  assert.equal(markers().length, 1);
  layer.destroy();
});

test('the sites are one set of icons, shown only while the layer is on', async (t) => {
  const { layer, draw, state, markers } = harness(t);
  const set = () => draw.find('speed-cameras');
  assert.equal(set().kind, 'icons');
  assert.equal(set().show, false);
  assert.equal(set().spec.horizonCull, true);
  layer.enable();
  assert.equal(set().show, true);
  await layer.update();
  assert.equal(markers().length, 1);
  layer.disable();
  assert.equal(set().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
  assert.equal(set(), undefined, 'the set is disposed');
});

test('without ground heights the markers clamp to every surface; with them to terrain only', (t) => {
  assert.equal(harness(t).draw.find('speed-cameras').spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(
    harness(t, [site()], { terrain }).draw.find('speed-cameras').spec.clampTo,
    'terrain',
  );
});

test('a site without a direction is a dot, one with is an arrow turned to it', async (t) => {
  const { layer, feed, markers } = harness(t, [
    site({ id: '1', bearing: 90 }),
    site({ id: '2', bearing: null }),
  ]);
  layer.enable();
  await layer.update();
  const [arrow, dot] = markers();
  const drew = (item, name) =>
    item.image.canvas.calls.some(([call]) => call === name);
  assert.notEqual(arrow.image, dot.image);
  assert.equal(drew(arrow, 'lineTo'), true);
  assert.equal(drew(dot, 'lineTo'), false);
  assert.equal(arrow.image.key, 'speed-camera-arrow');
  assert.equal(dot.image.key, 'speed-camera-dot');
  // Turned clockwise from north, up along the Earth's axis as Cesium's
  // aligned billboards stood.
  assert.equal(arrow.rotationMode, 'axis');
  assert.deepEqual(arrow.alignedAxis, { x: 0, y: 0, z: 1 });
  assert.equal(arrow.rotation, -(90 * (Math.PI / 180)));
  assert.equal(dot.rotation, 0);
  assert.deepEqual(arrow.size, [24, 24]);
  assert.equal(arrow.height, 'clampGround');
  assert.deepEqual(arrow.pos, { lon: 17.9, lat: 59.47, height: 0 });
  assert.equal(arrow.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(arrow.displayRange, [0, 400_000]);
  assert.deepEqual(arrow.scaleByDistance, {
    near: 2_000,
    nearValue: 1,
    far: 400_000,
    farValue: 0.45,
  });

  assert.deepEqual(
    layer.getRowControls().legend.map((entry) => entry.count),
    [1, 1],
  );
  assert.equal(layer.getStats().count, 2);

  // Every site with a direction: no line for the ones without.
  feed.cameras = [site({ id: '1' }), site({ id: '2', bearing: 270 })];
  await layer.update();
  assert.deepEqual(
    layer.getRowControls().legend.map((entry) => entry.count),
    [2],
  );
  layer.destroy();
});

test('a new name on a site shows on its card', async (t) => {
  const { layer, feed, state } = harness(t);
  layer.enable();
  await layer.update();
  state.picked = 'se-speed-camera:1';
  state.click();
  assert.equal(state.cards[0].id, 'speed-camera-card:1');
  assert.ok(state.cards[0].details.includes('Rotebro'));
  assert.ok(state.cards[0].position, 'the card sits on the site');

  // Same id, point and direction; only the name and the county are new.
  feed.cameras = [site({ name: 'Rotebro norra', county: 'Uppsala län' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Rotebro norra'));
  assert.ok(state.cards[0].details.some((line) => /Uppsala län/.test(line)));
  layer.destroy();
});

test('a click on the ground closes the card; another layer’s card or dot leaves it', async (t) => {
  const { layer, state } = harness(t, [site(), site({ id: '2' })]);
  layer.enable();
  await layer.update();
  state.picked = 'se-speed-camera:1';
  state.click();
  assert.equal(state.cards[0].id, 'speed-camera-card:1');

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  state.picked = 'se-speed-camera:2';
  state.click();
  assert.equal(
    state.cards[0].id,
    'speed-camera-card:1',
    'a card is not the ground',
  );
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    state.picked = 'se-hospital:1';
    state.click();
    assert.equal(
      state.cards[0].id,
      'speed-camera-card:1',
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, [], 'the ground lets go');
  layer.destroy();
});

test('a site that comes twice is drawn once', async (t) => {
  const { layer, markers } = harness(t, [
    site({ name: 'First' }),
    site({ name: 'Second' }),
    site({ id: '2' }),
  ]);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().count, 2);
  assert.deepEqual(
    markers().map((item) => item.id),
    ['se-speed-camera:1', 'se-speed-camera:2'],
  );
  layer.destroy();
});

test('the card goes when the view moves out of reach of its marker', async (t) => {
  const { layer, camera, state } = harness(t);
  layer.enable();
  await layer.update();
  assert.equal(camera.listenerCount('moveEnd'), 1);
  const moved = (heightM) => {
    camera.setPose(eyeAt(heightM));
    camera.emit('moveEnd');
  };

  // Nothing selected: a move changes nothing.
  moved(500_000);
  assert.deepEqual(state.cards, []);

  assert.equal(layer.selectById('1'), true);
  assert.equal(layer.selectById('nope'), false);
  moved(300_000);
  assert.equal(state.cards.length, 1, 'within reach the card stays');
  moved(500_000);
  assert.deepEqual(state.cards, [], 'beyond 400 km the marker is hidden');

  // Switched off and on again there is still one listener, then none.
  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  layer.enable();
  layer.enable();
  assert.equal(camera.listenerCount('moveEnd'), 1);
  layer.destroy();
  assert.equal(camera.listenerCount('moveEnd'), 0);
});

test('switching the layer off drops the last failure', async (t) => {
  const { layer, feed } = harness(t);
  layer.enable();
  feed.error = new Error('HTTP 502');
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'HTTP 502');
  layer.disable();
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});
