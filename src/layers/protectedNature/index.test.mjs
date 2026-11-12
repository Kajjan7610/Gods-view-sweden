// The protected nature layer's life: areas read for the view, drawn as one
// batch, the national parks alone when wide, and a card that opens the area.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createProtectedNatureLayer } from './index.js';
import { encodeLine } from '../electionDistricts/records.js';

const square = (lon, lat) =>
  encodeLine([
    [lon, lat],
    [lon + 0.01, lat],
    [lon + 0.01, lat + 0.01],
    [lon, lat + 0.01],
    [lon, lat],
  ]);
const area = (i, t, lon, lat) => ({
  i,
  n: `Area ${i}`,
  t,
  y: 1993,
  k: 'Haninge',
  h: 1962,
  b: [lon, lat, lon + 0.01, lat + 0.01],
  g: [[square(lon, lat)]],
});

function harness(t, { height = 20_000, wide = false, capped = false } = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { height, reads: [], picked: undefined, click: null, hit: null };
  const opened = [];
  const sources = [];
  const viewer = {
    dataSources: {
      add: (source) => sources.push(source),
      remove() {},
    },
    scene: {
      globe: { show: true },
      pick: () => state.picked,
      requestRender() {},
    },
    camera: {
      get positionCartographic() {
        return { height: state.height };
      },
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(18.1, 59.1, 18.4, 59.3),
      moveEnd: { addEventListener: () => () => {} },
      changed: { addEventListener: () => () => {} },
    },
  };
  const shown = new Map();
  const layer = createProtectedNatureLayer({
    source: {
      getAreas: async ({ bbox }) => {
        state.reads.push(bbox);
        return {
          areas: [
            area('2000001', 'np', 18.25, 59.18),
            area('2000002', 'nr', 18.2, 59.2),
            area('2000003', 'nr', 18.3, 59.15),
          ],
          wide,
          capped,
          source: 'Naturvårdsverket',
          built: '2026-11-12',
        };
      },
    },
    overlayHost: {
      setEntries: (id, entries) => shown.set(id, entries),
      setVisible() {},
      clearSource: (id) => shown.delete(id),
      hitTest: () => state.hit,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  // Areas and their outlines are the first data source.
  const drawn = () => sources[0].entities.values.length;
  return { layer, state, drawn, shown, opened };
}

const legendLabels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);

test('a view reads and draws its areas, each kind in its colour', async (t) => {
  const { layer, state, drawn } = harness(t);
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 1);
  // The view box, padded a quarter on each side.
  const [w, s, e, n] = state.reads[0];
  assert.ok(w < 18.1 && s < 59.1 && e > 18.4 && n > 59.3);
  assert.equal(drawn(), 6, 'an area and an outline per area');
  assert.deepEqual(legendLabels(layer), ['National park 1', 'Nature reserve 2']);
  assert.equal(layer.getRowControls().info, '');
  assert.equal(layer.getStats().count, 3);
  // The same view again: nothing new to read.
  await layer.update();
  assert.equal(state.reads.length, 1);
  layer.disable();
  assert.equal(drawn(), 0);
});

test('a wide view asks to zoom in for the reserves, and reads again', async (t) => {
  const { layer, state } = harness(t, { wide: true });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see the nature reserves and culture reserves.',
  );
  await layer.update();
  assert.equal(state.reads.length, 2);
});

test('a capped view says how many areas it shows', async (t) => {
  const { layer } = harness(t, { capped: true });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'The 3 areas nearest the centre are shown.',
  );
});

test('a view from too high reads nothing', async (t) => {
  const { layer, state, drawn } = harness(t, { height: 5_000_000 });
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 0);
  assert.equal(drawn(), 0);
});

test('a click on an area shows its card; a click on the card opens Skyddad natur', async (t) => {
  const { layer, state, shown, opened } = harness(t);
  layer.enable();
  await layer.update();
  state.picked = { id: { id: 'protected-nature:2000001:0:1' } };
  state.click({ position: { x: 1, y: 1 } });
  const [card] = shown.get('protected-nature');
  assert.equal(card.title, 'NATIONAL PARK · Area 2000001');
  assert.equal(layer.areaAt([18.255, 59.185])?.i, '2000001');
  assert.equal(layer.areaAt([18.0, 59.0]), null);

  state.hit = { sourceId: 'protected-nature', entryId: card.id };
  state.click({ position: { x: 1, y: 1 } });
  assert.deepEqual(opened, [
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2000001',
  ]);
  // The card stays: a click on it is not one on the map.
  assert.equal(shown.get('protected-nature').length, 1);
  assert.equal(card.activate(), true);
  assert.equal(opened.length, 2);

  state.hit = null;
  state.picked = undefined;
  state.click({ position: { x: 1, y: 1 } });
  assert.deepEqual(shown.get('protected-nature'), []);
});

test('an area is selected by its id while shown', async (t) => {
  const { layer, shown } = harness(t);
  assert.equal(layer.setParams({ nvrid: '2000002' }), false);
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ nvrid: '2000002' }), true);
  assert.equal(
    shown.get('protected-nature')[0].title,
    'NATURE RESERVE · Area 2000002',
  );
  assert.equal(layer.setParams({ nvrid: 'nope' }), false);
});
