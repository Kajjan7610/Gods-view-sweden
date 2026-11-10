// The speed camera layer: arrows and dots, the card, and what a bad round leaves.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
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

function fakeViewer() {
  const moveEnd = [];
  const viewer = {
    sources: [],
    picked: undefined,
    moveEnd,
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove: (source) =>
        viewer.sources.splice(viewer.sources.indexOf(source), 1),
    },
    scene: { pick: () => viewer.picked, requestRender() {} },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(17.9, 59.47, 2_000),
      moveEnd: {
        addEventListener(listener) {
          moveEnd.push(listener);
          return () => moveEnd.splice(moveEnd.indexOf(listener), 1);
        },
      },
    },
  };
  return viewer;
}

/** A layer on a fake viewer, fed by `feed.cameras` (or failing on `feed.error`). */
function harness(t, cameras = [site()]) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const viewer = fakeViewer();
  const feed = { cameras, error: null };
  const state = { cards: [], cardHit: null, click: null };
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
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
  });
  layer.init(viewer);
  return { layer, viewer, feed, state };
}

const CLICK = { position: { x: 10, y: 20 } };
const markers = (viewer) => viewer.sources[0].entities.values;

// First: the markers are drawn once and kept, so only the first round of
// this file can meet a canvas that fails.
test('a drawing that failed is made again on the next round', async (t) => {
  const { layer, viewer } = harness(t);
  layer.enable();
  drawing.failNext = true;
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'no canvas');
  assert.equal(markers(viewer).length, 0);

  // The same answer again: it was never drawn, so it is drawn now.
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  assert.equal(markers(viewer).length, 1);
  layer.destroy();
});

test('a site without a direction is a dot, one with is an arrow turned to it', async (t) => {
  const { layer, viewer, feed } = harness(t, [
    site({ id: '1', bearing: 90 }),
    site({ id: '2', bearing: null }),
  ]);
  layer.enable();
  await layer.update();
  const [arrow, dot] = markers(viewer).map((entity) => ({
    image: entity.billboard.image.getValue(),
    rotation: entity.billboard.rotation.getValue(),
  }));
  const drew = (image, name) => image.calls.some(([call]) => call === name);
  assert.notEqual(arrow.image, dot.image);
  assert.equal(drew(arrow.image, 'lineTo'), true);
  assert.equal(drew(dot.image, 'lineTo'), false);
  assert.equal(arrow.rotation, -Cesium.Math.toRadians(90));
  assert.equal(dot.rotation, 0);

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
  const { layer, viewer, feed, state } = harness(t);
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-speed-camera:1' };
  state.click(CLICK);
  assert.equal(state.cards[0].id, 'speed-camera-card:1');
  assert.ok(state.cards[0].details.includes('Rotebro'));

  // Same id, point and direction; only the name and the county are new.
  feed.cameras = [site({ name: 'Rotebro norra', county: 'Uppsala län' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Rotebro norra'));
  assert.ok(state.cards[0].details.some((line) => /Uppsala län/.test(line)));
  layer.destroy();
});

test('a site that comes twice is drawn once', async (t) => {
  const { layer, viewer } = harness(t, [
    site({ name: 'First' }),
    site({ name: 'Second' }),
    site({ id: '2' }),
  ]);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().count, 2);
  assert.deepEqual(
    markers(viewer).map((entity) => entity.id),
    ['se-speed-camera:1', 'se-speed-camera:2'],
  );
  layer.destroy();
});

test('the card goes when the view moves out of reach of its marker', async (t) => {
  const { layer, viewer, state } = harness(t);
  layer.enable();
  await layer.update();
  assert.equal(viewer.moveEnd.length, 1);
  const moved = (heightM) => {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      17.9,
      59.47,
      heightM,
    );
    viewer.moveEnd[0]();
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
  assert.equal(viewer.moveEnd.length, 0);
  layer.enable();
  layer.enable();
  assert.equal(viewer.moveEnd.length, 1);
  layer.destroy();
  assert.equal(viewer.moveEnd.length, 0);
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
