// The protected nature layer's life: areas read for the view, drawn as one
// batch of areas and one of outlines through the renderer's draw port, the
// national parks alone when wide, the Natura 2000 areas and bans only when
// close and switched on, and a card that opens the area.
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
  {
    height = 20_000,
    wide = false,
    close = !wide,
    capped = false,
    rect = undefined,
    extras = [],
  } = {},
) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = {
    reads: [],
    skips: [],
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
      getAreas: async ({ bbox, skip }) => {
        state.reads.push(bbox);
        state.skips.push(skip);
        return {
          areas: [
            area('2000001', 'np', 18.25, 59.18),
            area('2000002', 'nr', 18.2, 59.2),
            area('2000003', 'nr', 18.3, 59.15),
            ...extras.filter((extra) => !skip?.includes(extra.t)),
          ],
          wide,
          close,
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
    'Zoom in to see the nature reserves, culture reserves, Natura 2000 areas and access bans.',
  );
  await layer.update();
  assert.equal(state.reads.length, 2);
  // With both switched off, the reserves alone are asked for.
  for (const id of ['n2k', 'ban'])
    layer
      .getRowControls()
      .chips.find((chip) => chip.id === id)
      .onClick();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see the nature reserves and culture reserves.',
  );
});

test('a view not yet close asks to zoom in for the Natura 2000 areas, and reads them when close', async (t) => {
  const { layer, state } = harness(t, { close: false });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in further to see the Natura 2000 areas and access bans.',
  );
  // The same view again is read again: a close one may have come.
  await layer.update();
  assert.equal(state.reads.length, 2);
});

const N2K = Object.assign(area('SE0110001', 'n2k', 18.21, 59.21), {
  d: 'spa-sci',
  y: 1996,
});
const BAN = Object.assign(area('tf1935789', 'ban', 18.26, 59.19), {
  r: '2004016',
  s: 'seal',
  p: [1, 4, 31, 7],
  k: 'Stockholms län',
  h: 1.9,
});

test('Natura 2000 lies under the reserves in a light fill, the bans on top', async (t) => {
  const { layer, items } = harness(t, { extras: [BAN, N2K] });
  layer.enable();
  await layer.update();
  assert.deepEqual(
    items('areas').map((item) => [item.id, item.fill]),
    [
      ['protected-nature:SE0110001:0', [...kindFill('n2k').slice(0, 3), 0.2]],
      ['protected-nature:2000001:0', kindFill('np')],
      ['protected-nature:2000002:0', kindFill('nr')],
      ['protected-nature:2000003:0', kindFill('nr')],
      ['protected-nature:tf1935789:0', kindFill('ban')],
    ],
  );
  const [natura] = items('edges');
  assert.deepEqual(natura.style.color, [...kindFill('n2k').slice(0, 3), 0.9]);
  assert.deepEqual(legendLabels(layer), [
    'National park 1',
    'Nature reserve 2',
    'Natura 2000 area 1',
    'Access ban 1',
  ]);
});

test('the Natura 2000 and ban switches drop their areas and ask without them', async (t) => {
  const { layer, state, shown, items } = harness(t, { extras: [N2K, BAN] });
  layer.enable();
  await layer.update();
  const chips = () => layer.getRowControls().chips;
  assert.deepEqual(
    chips().map(({ id, label, active, color }) => [id, label, active, color]),
    [
      ['n2k', 'NATURA 2000', true, '#1e88e5'],
      ['ban', 'ACCESS BANS', true, '#f4511e'],
    ],
  );
  assert.deepEqual(state.skips[0], []);
  assert.equal(layer.setParams({ nvrid: 'tf1935789' }), true);
  assert.equal(shown.get('protected-nature').length, 1);
  chips()[1].onClick();
  // At once: the bans gone, their card with them; then a new read.
  assert.equal(chips()[1].active, false);
  assert.ok(!items('areas').some(({ id }) => id.includes('tf1935789')));
  assert.deepEqual(shown.get('protected-nature'), []);
  await layer.update();
  assert.deepEqual(state.skips.at(-1), ['ban']);
  assert.ok(items('areas').some(({ id }) => id.includes('SE0110001')));
  chips()[0].onClick();
  await layer.update();
  assert.deepEqual(state.skips.at(-1), ['n2k', 'ban']);
  assert.equal(items('areas').length, 3);
  chips()[1].onClick();
  await layer.update();
  assert.deepEqual(state.skips.at(-1), ['n2k']);
  assert.ok(items('areas').some(({ id }) => id.includes('tf1935789')));
});

test('a ban card opens its protected area; a Natura 2000 card opens nothing', async (t) => {
  const { layer, state, shown, opened } = harness(t, { extras: [N2K, BAN] });
  layer.enable();
  await layer.update();
  layer.setParams({ nvrid: 'tf1935789' });
  let [card] = shown.get('protected-nature');
  assert.equal(card.title, 'ACCESS BAN · Area tf1935789');
  assert.ok(
    card.details.includes('Seal protection · No entry April 1 – July 31'),
  );
  state.hit = { sourceId: 'protected-nature', entryId: card.id };
  state.click();
  assert.deepEqual(opened, [
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2004016',
  ]);
  state.hit = null;
  layer.setParams({ nvrid: 'SE0110001' });
  [card] = shown.get('protected-nature');
  assert.equal(card.title, 'NATURA 2000 · Area SE0110001');
  assert.equal(card.activate, undefined);
  assert.ok(!card.details.includes('Skyddad natur ↗ · click card to open'));
  state.hit = { sourceId: 'protected-nature', entryId: card.id };
  state.click();
  assert.equal(opened.length, 1);
  const records = layer.getAnalystRecords();
  const ban = records.find(({ id }) => id === 'tf1935789');
  assert.equal(ban.kind, 'Access ban');
  assert.equal(ban.county, 'Stockholms län');
  assert.equal(ban.banPeriod, 'No entry April 1 – July 31');
  const natura = records.find(({ id }) => id === 'SE0110001');
  assert.equal(natura.kind, 'Natura 2000 area');
  assert.equal(natura.inNatura2000Since, '1996');
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

test('the areas shown are records at their boxes’ middles', async (t) => {
  const { layer } = harness(t);
  layer.enable();
  await layer.update();
  const records = layer.getAnalystRecords();
  assert.deepEqual(
    records.map(({ id, name }) => [id, name]),
    [
      ['2000001', 'Area 2000001'],
      ['2000002', 'Area 2000002'],
      ['2000003', 'Area 2000003'],
    ],
  );
  const [park] = records;
  assert.ok(Math.abs(park.lon - 18.255) < 1e-9);
  assert.ok(Math.abs(park.lat - 59.185) < 1e-9);
  assert.equal(park.kind, 'National park');
  assert.equal(park.municipality, 'Haninge');
  assert.equal(park.hectares, 1962);
  assert.equal(layer.getAnalystRecords(2).length, 2);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});
