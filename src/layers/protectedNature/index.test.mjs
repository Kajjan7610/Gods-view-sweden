// The protected nature layer's life: areas read for the view, drawn as one
// batch of areas and one of outlines through the renderer's draw port, the
// national parks alone when wide, and a card that opens the area.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { cssColor } from '../../render/color.js';
import * as picking from '../../data/pickRegistry.js';
import {
  AREA_KINDS,
  PROTECTED_NATURE_LAYER_ID,
  createProtectedNatureLayer,
} from './index.js';
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

function harness(
  t,
  { height = 20_000, wide = false, capped = false, rect = undefined } = {},
) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = {
    reads: [],
    picked: null,
    click: null,
    hit: null,
    globeVisible: true,
  };
  const opened = [];
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { lon: 18.25, lat: 59.2, height },
    viewRectangle:
      rect === undefined
        ? { west: 18.1, south: 59.1, east: 18.4, north: 59.3 }
        : rect,
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    globe: { isGlobeVisible: () => state.globeVisible },
  });
  const stack = new EventTarget();
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
    picking,
    mapStackEventTarget: stack,
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({ screenPosition: { x: 1, y: 1 }, topHit: state.picked });
        return () => (state.click = null);
      },
    }),
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  const set = (name) => draw.set(`${PROTECTED_NATURE_LAYER_ID}:${name}`);
  const items = (name) => [...(set(name)?.items.values() ?? [])];
  const drawn = () => set('areas').items.size + set('edges').items.size;
  return { layer, state, draw, set, items, drawn, shown, opened, stack };
}

const legendLabels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);
const kindFill = (id) => {
  const [r, g, b] = cssColor(AREA_KINDS.find((kind) => kind.id === id).color);
  return [r, g, b, 0.4];
};

test('a view reads and draws its areas, each kind in its colour', async (t) => {
  const { layer, state, set, items, drawn } = harness(t);
  assert.equal(set('areas').kind, 'shapes');
  assert.equal(set('edges').kind, 'lines');
  assert.equal(set('selected').kind, 'lines');
  assert.equal(set('areas').show, false);
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 1);
  // The view box, padded a quarter on each side.
  const [w, s, e, n] = state.reads[0];
  assert.ok(w < 18.1 && s < 59.1 && e > 18.4 && n > 59.3);
  assert.equal(drawn(), 6, 'an area and an outline per area');
  assert.equal(set('areas').show, true);
  assert.equal(set('edges').show, true);
  assert.deepEqual(
    items('areas').map((item) => [item.id, item.fill, item.height]),
    [
      ['protected-nature:2000001:0', kindFill('np'), 'clampGround'],
      ['protected-nature:2000002:0', kindFill('nr'), 'clampGround'],
      ['protected-nature:2000003:0', kindFill('nr'), 'clampGround'],
    ],
  );
  const [edge] = items('edges');
  assert.equal(edge.mode, 'draped');
  assert.equal(edge.widthPx, 1.2);
  assert.deepEqual(edge.style, { kind: 'solid', color: [1, 1, 1, 0.4] });
  assert.deepEqual(legendLabels(layer), [
    'National park 1',
    'Nature reserve 2',
  ]);
  assert.equal(layer.getRowControls().info, '');
  assert.equal(layer.getStats().count, 3);
  // The same view again: nothing new to read.
  await layer.update();
  assert.equal(state.reads.length, 1);
  layer.disable();
  assert.equal(drawn(), 0);
  assert.equal(set('areas').show, false);
  layer.destroy();
  assert.equal(set('areas'), undefined, 'disposed');
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

test('a view that sees the horizon reads Sweden', async (t) => {
  const { layer, state } = harness(t, { rect: null });
  layer.enable();
  await layer.update();
  assert.deepEqual(state.reads[0], [10, 55, 24.5, 69.2]);
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

test('the areas follow the map stack to the surface it shows', async (t) => {
  const { layer, draw, state, stack } = harness(t);
  const clamps = () =>
    [...draw.sets.values()].map((record) => record.spec.clampTo);
  assert.deepEqual(clamps(), ['terrain', 'terrain', 'terrain']);
  layer.enable();
  state.globeVisible = false;
  stack.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.deepEqual(clamps(), ['tiles', 'tiles', 'tiles']);
  layer.disable();
  state.globeVisible = true;
  stack.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.deepEqual(clamps(), ['tiles', 'tiles', 'tiles'], 'waits for enable');
  layer.enable();
  assert.deepEqual(clamps(), ['terrain', 'terrain', 'terrain']);
});

test('a click on an area shows its card; a click on the card opens Skyddad natur', async (t) => {
  const { layer, state, shown, opened, items } = harness(t);
  layer.enable();
  await layer.update();
  state.picked = {
    set: 'protected-nature:areas',
    id: 'protected-nature:2000001:0',
    surface: false,
  };
  state.click();
  const [card] = shown.get('protected-nature');
  assert.equal(card.title, 'NATIONAL PARK · Area 2000001');
  assert.equal(layer.areaAt([18.255, 59.185])?.i, '2000001');
  assert.equal(layer.areaAt([18.0, 59.0]), null);
  const [outline] = items('selected');
  assert.equal(outline.widthPx, 3.5);
  assert.deepEqual(outline.style, { kind: 'solid', color: [1, 1, 1, 0.95] });

  state.hit = { sourceId: 'protected-nature', entryId: card.id };
  state.click();
  assert.deepEqual(opened, [
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2000001',
  ]);
  // The card stays: a click on it is not one on the map.
  assert.equal(shown.get('protected-nature').length, 1);
  assert.equal(card.activate(), true);
  assert.equal(opened.length, 2);

  // Another layer's card or object is not the map either.
  state.hit = { sourceId: 'hospitals', entryId: 'x' };
  state.click();
  state.hit = null;
  state.picked = { set: 'hospitals', id: 'se-hospital:1', surface: false };
  state.click();
  assert.equal(shown.get('protected-nature').length, 1);
  assert.equal(opened.length, 2);
  // Its ids are the layer's own, for other layers' clicks.
  assert.equal(
    picking.findPickOwner('protected-nature:2000002:0'),
    PROTECTED_NATURE_LAYER_ID,
  );

  state.picked = null;
  state.click();
  assert.deepEqual(shown.get('protected-nature'), []);
  assert.deepEqual(items('selected'), []);
  layer.disable();
  assert.equal(state.click, null, 'no clicks while off');
  assert.equal(picking.findPickOwner('protected-nature:2000002:0'), null);
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
