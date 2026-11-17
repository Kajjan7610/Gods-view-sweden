// The heritage remains layer: read for low views only, dots coloured by
// assessment, a card on a click and RAÄ's page from the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  ASSESSMENT,
  HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
  createHeritageRemainsLayer,
} from './index.js';

const remain = (n, lon, lat, assessment, distance) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  point: [lon, lat],
  type: 'Gravfält',
  number: `L1:${n}`,
  raa: null,
  name: null,
  municipality: 'Västerås',
  assessment,
  confirmed: true,
  page: `10000000-0000-4000-8000-00000000000${n}`,
  distance,
});
const ROWS = [
  remain(1, 16.545, 59.611, 'fl', 90),
  remain(2, 16.55, 59.615, 'okl', 600),
  remain(3, 16.56, 59.62, 'fl', 1500),
];

function harness({
  height = 3000,
  answer = {},
  centre = [16.5448, 59.6105],
  terrain = null,
} = {}) {
  const reads = [];
  const opened = [];
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 16.54, lat: 59.6, height },
    viewRectangle: { west: 16.5, south: 59.59, east: 16.6, north: 59.63 },
  });
  const picks = [];
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: {
      pickEllipsoid(x, y) {
        picks.push([x, y]);
        return centre ? fromDegrees(centre[0], centre[1]) : null;
      },
    },
  });
  const layer = createHeritageRemainsLayer({
    source: {
      getSnapshot: async (query) => {
        reads.push(query);
        return {
          remains: ROWS,
          total: ROWS.length,
          tooWide: false,
          capped: false,
          stale: false,
          fetchedAt: Date.parse('2026-11-12T20:00:00Z'),
          ...answer,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, HERITAGE_REMAINS_OVERLAY_SOURCE_ID);
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
            screenPosition: { x: 1, y: 1 },
            topHit: state.picked
              ? { set: 'heritage-remains', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
    terrain,
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  const set = () => draw.find('heritage-remains');
  const drawn = () => [...(set()?.items.values() ?? [])];
  return { layer, camera, state, reads, opened, drawn, set, picks };
}

const labels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);

test('the remains are one set of dots, shown only while the layer is on', async () => {
  const { layer, set, state } = harness();
  assert.equal(set().kind, 'points');
  assert.equal(set().show, false);
  assert.equal(set().spec.horizonCull, true);
  layer.enable();
  assert.equal(set().show, true);
  await layer.update();
  layer.disable();
  assert.equal(set().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
  assert.equal(set(), undefined, 'the set is disposed');
});

test('without ground heights the dots clamp to every surface; with them to terrain only', () => {
  assert.equal(harness().set().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness({ terrain }).set().spec.clampTo, 'terrain');
});

test('a low view reads its box and draws a dot per remain', async () => {
  const { layer, reads, drawn, picks } = harness();
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 1);
  const [w, s, e, n] = reads[0].bbox;
  assert.ok(e - w <= 0.15 + 1e-9 && n - s <= 0.15 + 1e-9);
  assert.deepEqual(
    reads[0].center.map((v) => Math.round(v * 1e4) / 1e4),
    [16.5448, 59.6105],
  );
  assert.deepEqual(picks.at(-1), [400, 300], 'the centre of the canvas');
  assert.equal(drawn().length, 3);
  assert.deepEqual(labels(layer), [
    'Ancient monument (protected) 2',
    'Other cultural-historical remain 1',
  ]);
  assert.equal(layer.getRowControls().info, '3 remains in view');
  assert.equal(layer.getStats().count, 3);
  layer.disable();
  assert.equal(drawn().length, 0);
});

test('a dot is coloured and sized by assessment, the nearest drawn last', async () => {
  const { layer, drawn } = harness();
  layer.enable();
  await layer.update();
  const items = drawn();
  assert.deepEqual(
    items.map((item) => item.id),
    [...ROWS].reverse().map((row) => `se-remain:${row.id}`),
  );
  const nearest = items.at(-1);
  assert.equal(nearest.color, ASSESSMENT.fl.color);
  assert.equal(nearest.pixelSize, 8);
  assert.equal(items[1].pixelSize, 6);
  assert.equal(nearest.outlineColor, '#1a120b');
  assert.equal(nearest.outlineWidth, 1.5);
  assert.equal(nearest.height, 'clampGround');
  assert.deepEqual(nearest.pos, { lon: 16.545, lat: 59.611, height: 0 });
  assert.equal(nearest.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(nearest.scaleByDistance, {
    near: 300,
    nearValue: 1.3,
    far: 12000,
    farValue: 0.7,
  });
  layer.destroy();
});

test('a centre off the globe falls back to the point under the eye', async () => {
  const { layer, reads } = harness({ centre: null });
  layer.enable();
  await layer.update();
  assert.deepEqual(reads[0].center, [16.54, 59.6]);
  layer.destroy();
});

test('a high view reads nothing and asks to zoom in', async () => {
  const { layer, reads, drawn } = harness({ height: 50_000 });
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(drawn().length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see the remains: they show below 12 km',
  );
});

test('a camera move reads the view again once it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, camera, reads, drawn } = harness();
  layer.enable();
  assert.equal(camera.listenerCount('moveEnd'), 1);
  await layer.update();
  assert.equal(reads.length, 1);

  // Up out of reach: nothing is asked, and the dots go.
  camera.setPose({ height: 50_000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(399);
  assert.equal(drawn().length, 3, 'not before the move settles');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  assert.equal(drawn().length, 0);

  // Down again: the view is read once more.
  camera.setPose({ height: 3000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2);
  assert.equal(drawn().length, 3);

  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  layer.destroy();
});

test('a capped box asks to zoom in for the rest', async () => {
  const { layer } = harness({ answer: { capped: true } });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see every remain here.',
  );
});

test('a click on a dot shows its card; a click on the card opens RAÄ', async () => {
  const { layer, state, opened } = harness();
  layer.enable();
  await layer.update();
  state.picked = `se-remain:${ROWS[1].id}`;
  state.click();
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, 'REMAIN · Gravfält');
  assert.ok(state.cards[0].position, 'the card sits on the remain');
  state.cardHit = {
    sourceId: HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
    entryId: state.cards[0].id,
  };
  state.click();
  assert.deepEqual(opened, [
    `https://pub.raa.se/visa/objekt/lamning/${ROWS[1].page}`,
  ]);
  assert.equal(
    state.cards.length,
    1,
    'a click on the card is not one on the map',
  );
  assert.equal(state.cards[0].activate(), true);
  assert.equal(opened.length, 2);
  state.cardHit = null;
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, []);
  assert.equal(layer.remainAt([16.5451, 59.6112])?.number, 'L1:1');
});

test("a click on another layer's card or dot leaves the open card alone", async () => {
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  state.picked = `se-remain:${ROWS[0].id}`;
  state.click();
  const open = state.cards[0].id;
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  state.picked = null;
  state.click();
  assert.equal(state.cards[0]?.id, open, 'a card is not the ground');
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    state.picked = 'se-hospital:1';
    state.click();
    assert.equal(
      state.cards[0]?.id,
      open,
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  layer.destroy();
});
