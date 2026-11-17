// The election district layer's life: districts read for low views only,
// drawn as one batch of areas and one of outlines through the renderer's
// draw port, coloured by party or turnout, and a card on a click.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { hexColor } from '../../render/color.js';
import * as picking from '../../data/pickRegistry.js';
import {
  ELECTION_DISTRICTS_LAYER_ID,
  createElectionDistrictsLayer,
} from './index.js';
import { encodeLine } from './records.js';

const square = (lon, lat) =>
  encodeLine([
    [lon, lat],
    [lon + 0.01, lat],
    [lon + 0.01, lat + 0.01],
    [lon, lat + 0.01],
    [lon, lat],
  ]);
const district = (c, lon, lat, shares, turnout = 850) => ({
  c,
  n: `District ${c}`,
  k: '0180',
  m: 'Stockholm',
  b: [lon, lat, lon + 0.01, lat + 0.01],
  g: [[square(lon, lat)]],
  v: 1000,
  s: shares,
  t: turnout,
});

function harness(t, { height = 20_000 } = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = {
    reads: [],
    picked: null,
    click: null,
    cardHit: null,
    globeVisible: true,
  };
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { lon: 18.05, lat: 59.32, height },
    viewRectangle: { west: 17.9, south: 59.25, east: 18.2, north: 59.4 },
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    globe: { isGlobeVisible: () => state.globeVisible },
  });
  const stack = new EventTarget();
  const shown = new Map();
  const layer = createElectionDistrictsLayer({
    source: {
      getDistricts: async ({ bbox }) => {
        state.reads.push(bbox);
        return {
          districts: [
            district(
              '01800101',
              18.0,
              59.3,
              [300, 250, 200, 50, 50, 50, 50, 40, 10],
              900,
            ),
            district(
              '01800102',
              18.05,
              59.32,
              [200, 350, 200, 50, 50, 50, 50, 40, 10],
              760,
            ),
          ],
          capped: false,
          source: 'Valmyndigheten',
          election: 'Riksdag 2026',
          built: '2026-11-12',
        };
      },
    },
    overlayHost: {
      setEntries: (id, entries) => shown.set(id, entries),
      setVisible() {},
      clearSource: (id) => shown.delete(id),
      hitTest: () => state.cardHit,
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
  });
  layer.init(viewer);
  const set = (name) => draw.set(`${ELECTION_DISTRICTS_LAYER_ID}:${name}`);
  const items = (name) => [...(set(name)?.items.values() ?? [])];
  const drawn = () => set('areas').items.size + set('edges').items.size;
  const areas = () => items('areas').map((item) => [item.id, item.fill]);
  return { layer, state, camera, draw, set, items, drawn, areas, shown, stack };
}

const legendLabels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);
const fill = (hex) => hexColor(hex, 0.45);

test('a low view reads and draws its districts, coloured by largest party', async (t) => {
  const { layer, state, set, items, drawn, areas } = harness(t);
  assert.equal(set('areas').kind, 'shapes');
  assert.equal(set('edges').kind, 'lines');
  assert.equal(set('selected').kind, 'lines');
  assert.equal(set('areas').show, false);
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 1);
  // The view box, padded a quarter on each side.
  const [w, s, e, n] = state.reads[0];
  assert.ok(w < 17.9 && s < 59.25 && e > 18.2 && n > 59.4);
  assert.equal(drawn(), 4, 'an area and an outline per district');
  assert.equal(set('areas').show, true);
  assert.equal(set('edges').show, true);
  assert.deepEqual(legendLabels(layer), ['S 1', 'M 1']);
  assert.deepEqual(areas(), [
    ['election-district:01800101:0', fill('#ed1b34')],
    ['election-district:01800102:0', fill('#52bdec')],
  ]);
  const [area] = items('areas');
  assert.equal(area.height, 'clampGround');
  assert.equal(area.geometry.kind, 'polygon');
  assert.deepEqual(area.geometry.rings[0][1], { lon: 18.01, lat: 59.3 });
  const [edge] = items('edges');
  assert.equal(edge.id, 'election-district:01800101:0:edge');
  assert.equal(edge.mode, 'draped');
  assert.equal(edge.widthPx, 1.2);
  assert.deepEqual(edge.style, { kind: 'solid', color: [1, 1, 1, 0.35] });
  // The ring as read and closed again.
  assert.equal(edge.positions.length, 6);
  assert.equal(layer.getStats().count, 2);
  // The same view again: nothing new to read.
  await layer.update();
  assert.equal(state.reads.length, 1);
  const edgeWrites = set('edges').writes;
  layer
    .getRowControls()
    .chips.find(({ id }) => id === 'turnout')
    .onClick();
  assert.deepEqual(legendLabels(layer), ['70 to 80 % 1', '90 % and above 1']);
  assert.deepEqual(
    areas().map(([, color]) => color),
    [fill('#fde725'), fill('#3b528b')],
  );
  assert.equal(set('edges').writes, edgeWrites, 'the outlines stay as drawn');
  layer.disable();
  assert.equal(drawn(), 0);
  assert.equal(set('areas').show, false);
  layer.destroy();
  assert.equal(set('areas'), undefined, 'disposed');
});

test('a high view reads nothing and asks to zoom in', async (t) => {
  const { layer, state, drawn } = harness(t, { height: 400_000 });
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 0);
  assert.equal(drawn(), 0);
  assert.equal(
    layer.getRowControls().info,
    'Zoom in below 120 km to see the election districts.',
  );
});

test('the camera settling reads the new view', async (t) => {
  const { layer, state, camera } = harness(t);
  layer.enable();
  await layer.update();
  camera.setViewRectangle({ west: 15, south: 57, east: 15.3, north: 57.2 });
  camera.emit('moveEnd');
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(state.reads.length, 2);
  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  assert.equal(camera.listenerCount('changed'), 0);
});

test('the areas follow the map stack to the surface it shows', async (t) => {
  const { layer, draw, state, stack } = harness(t);
  const clamps = () =>
    [...draw.sets.values()].map((record) => record.spec.clampTo);
  assert.deepEqual(clamps(), ['terrain', 'terrain', 'terrain']);
  layer.enable();
  await layer.update();
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

test('a click on a district shows its card; a click on the map clears it', async (t) => {
  const { layer, state, shown, items } = harness(t);
  layer.enable();
  await layer.update();
  state.picked = {
    set: 'election-districts:areas',
    id: 'election-district:01800102:0',
    surface: false,
  };
  state.click();
  const [card] = shown.get('election-districts');
  assert.equal(card.title, 'ELECTION DISTRICT · District 01800102');
  assert.equal(layer.districtAt([18.055, 59.325])?.c, '01800102');
  const [outline] = items('selected');
  assert.equal(outline.widthPx, 3.5);
  assert.deepEqual(outline.style, { kind: 'solid', color: [1, 1, 1, 0.95] });
  // Its outline is not a district: a click on it changes nothing.
  state.picked = {
    set: 'election-districts:selected',
    id: outline.id,
    surface: false,
  };
  state.click();
  assert.equal(shown.get('election-districts').length, 1);
  // Another layer's object is that layer's to select.
  state.picked = { set: 'hospitals', id: 'se-hospital:1', surface: false };
  state.click();
  assert.equal(shown.get('election-districts').length, 1);
  // A card under the click is not the map.
  state.picked = null;
  state.cardHit = { sourceId: 'hospitals', entryId: 'x' };
  state.click();
  assert.equal(shown.get('election-districts').length, 1);
  state.cardHit = null;
  state.click();
  assert.deepEqual(shown.get('election-districts'), []);
  assert.deepEqual(items('selected'), []);
  // An outline picks its district too, and the same district again lets go.
  state.picked = {
    set: 'election-districts:edges',
    id: 'election-district:01800101:0:edge',
    surface: false,
  };
  state.click();
  assert.equal(
    shown.get('election-districts')[0].title,
    'ELECTION DISTRICT · District 01800101',
  );
  state.click();
  assert.deepEqual(shown.get('election-districts'), []);
  // Its ids are the layer's own, for other layers' clicks.
  assert.equal(
    picking.findPickOwner('election-district:01800101:0'),
    ELECTION_DISTRICTS_LAYER_ID,
  );
  layer.disable();
  assert.equal(state.click, null, 'no clicks while off');
  assert.equal(picking.findPickOwner('election-district:01800101:0'), null);
});

test('a district is selected by its code while shown', async (t) => {
  const { layer, shown } = harness(t);
  assert.equal(layer.setParams({ districtCode: '01800101' }), false);
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ districtCode: '01800101' }), true);
  assert.equal(
    shown.get('election-districts')[0].title,
    'ELECTION DISTRICT · District 01800101',
  );
});
