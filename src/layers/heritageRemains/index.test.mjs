// The heritage remains layer: read for low views only, dots coloured by
// assessment, a card on a click and RAÄ's page from the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
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

function harness({ height = 3000, answer = {} } = {}) {
  const sources = [];
  const reads = [];
  const opened = [];
  const state = { cards: [], cardHit: null, click: null, picked: undefined };
  const viewer = {
    dataSources: { add: (s) => sources.push(s), remove() {} },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(16.54, 59.6, height),
      computeViewRectangle: () => Cesium.Rectangle.fromDegrees(16.5, 59.59, 16.6, 59.63),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(16.5448, 59.6105),
      moveEnd: { addEventListener: () => () => {} },
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      pick: () => state.picked,
      requestRender() {},
    },
  };
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
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  const drawn = () => sources[0].entities.values;
  return { layer, state, reads, opened, drawn };
}

const labels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);

test('a low view reads its box and draws a dot per remain', async () => {
  const { layer, reads, drawn } = harness();
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 1);
  const [w, s, e, n] = reads[0].bbox;
  assert.ok(e - w <= 0.15 + 1e-9 && n - s <= 0.15 + 1e-9);
  assert.deepEqual(reads[0].center.map((v) => Math.round(v * 1e4) / 1e4), [16.5448, 59.6105]);
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

test('a capped box asks to zoom in for the rest', async () => {
  const { layer } = harness({ answer: { capped: true } });
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls().info, 'Zoom in to see every remain here.');
});

test('a click on a dot shows its card; a click on the card opens RAÄ', async () => {
  const { layer, state, opened } = harness();
  layer.enable();
  await layer.update();
  state.picked = { id: `se-remain:${ROWS[1].id}` };
  state.click({ position: { x: 1, y: 1 } });
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, 'REMAIN · Gravfält');
  state.cardHit = { sourceId: HERITAGE_REMAINS_OVERLAY_SOURCE_ID, entryId: state.cards[0].id };
  state.click({ position: { x: 1, y: 1 } });
  assert.deepEqual(opened, [`https://pub.raa.se/visa/objekt/lamning/${ROWS[1].page}`]);
  assert.equal(state.cards.length, 1, 'a click on the card is not one on the map');
  assert.equal(state.cards[0].activate(), true);
  assert.equal(opened.length, 2);
  state.cardHit = null;
  state.picked = undefined;
  state.click({ position: { x: 1, y: 1 } });
  assert.deepEqual(state.cards, []);
  assert.equal(layer.remainAt([16.5451, 59.6112])?.number, 'L1:1');
});
