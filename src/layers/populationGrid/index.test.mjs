// The population grid layer's life: squares read for the view, the 1 km ones
// drawn as flat fills nobody can pick, the summed ones as fills with a card
// of rounded people, and no 1 km square ever handed to the analyst.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { cssColor } from '../../render/color.js';
import * as picking from '../../data/pickRegistry.js';
import {
  DENSITY_CLASSES,
  POPULATION_GRID_LAYER_ID,
  createPopulationGridLayer,
} from './index.js';

// A close view of central Stockholm (1 km squares) and a wide one (25 km).
const CLOSE = { west: 17.95, south: 59.28, east: 18.2, north: 59.38 };
const WIDE = { west: 11, south: 55.5, east: 24, north: 68.5 };
const FINE_ROWS = [
  [674, 6580, 1],
  [675, 6580, 6],
];
const SUMMED_ROWS = [
  [650, 6575, 0, null],
  [675, 6575, 2, 4320],
];

function harness(t, { height = 20_000, rect = CLOSE, capped = false } = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { reads: [], picked: null, click: null, hit: null, rect };
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { lon: 18.07, lat: 59.33, height },
    viewRectangle: rect,
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    globe: { isGlobeVisible: () => true },
  });
  const shown = new Map();
  const layer = createPopulationGridLayer({
    source: {
      getSquares: async ({ bbox }) => {
        state.reads.push(bbox);
        const wide = bbox[2] - bbox[0] > 5;
        return {
          squares: wide ? SUMMED_ROWS : FINE_ROWS,
          level: wide ? 25 : 1,
          capped,
          year: 2025,
          built: '2026-11-19',
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
    mapStackEventTarget: new EventTarget(),
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({ screenPosition: { x: 1, y: 1 }, topHit: state.picked });
        return () => (state.click = null);
      },
    }),
  });
  layer.init(viewer);
  const set = (name) => draw.set(`${POPULATION_GRID_LAYER_ID}:${name}`);
  const items = (name) => [...(set(name)?.items.values() ?? [])];
  return { layer, state, set, items, shown, camera };
}

const classFill = (index) => {
  const [r, g, b] = cssColor(DENSITY_CLASSES[index].color);
  return [r, g, b, [0.12, 0.16, 0.2, 0.25, 0.31, 0.37, 0.42][index]];
};

test('a close view draws its 1 km squares as flat fills nobody picks', async (t) => {
  const { layer, state, set, items } = harness(t);
  assert.equal(set('squares').kind, 'shapes');
  assert.equal(set('squares').spec.pickable, false);
  assert.equal(set('sums').spec.pickable, undefined);
  assert.equal(set('selected').kind, 'lines');
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 1);
  const fills = items('squares');
  assert.deepEqual(
    fills.map((item) => [item.id, item.fill, item.height, item.lit]),
    [
      ['population-grid:1:674:6580', classFill(1), 'clampGround', false],
      ['population-grid:1:675:6580', classFill(6), 'clampGround', false],
    ],
  );
  // A square's four true corners, turned from SWEREF 99 TM.
  const [ring] = fills[0].geometry.rings;
  assert.equal(ring.length, 4);
  assert.ok(ring.every(({ lon, lat }) => lon > 18 && lon < 18.1 && lat > 59.3));
  assert.deepEqual(items('sums'), []);
  assert.equal(set('squares').show, true);
  // "Under 1 per km²" is for summed squares alone.
  assert.equal(layer.getRowControls().legend.length, 6);
  assert.equal(layer.getRowControls().legend[0].label, '1–4 per km²');
  assert.equal(layer.getRowControls().info, '1 km squares (Source: SCB).');
  // The same view again: nothing new to read.
  await layer.update();
  assert.equal(state.reads.length, 1);
  layer.disable();
  assert.deepEqual(items('squares'), []);
  layer.destroy();
  assert.equal(set('squares'), undefined, 'disposed');
});

test('a 1 km square has no card and is never an analyst record', async (t) => {
  const { layer, state, shown } = harness(t);
  layer.enable();
  await layer.update();
  // Even were one picked, it opens nothing.
  state.picked = {
    set: 'population-grid:squares',
    id: 'population-grid:1:674:6580',
  };
  state.click();
  assert.deepEqual(shown.get('population-grid') ?? [], []);
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('a wide view draws summed squares with a card of rounded people', async (t) => {
  const { layer, state, items, shown } = harness(t, { rect: WIDE });
  layer.enable();
  await layer.update();
  assert.deepEqual(items('squares'), []);
  assert.deepEqual(
    items('sums').map((item) => [item.id, item.fill]),
    [
      ['population-grid:25:650:6575', classFill(0)],
      ['population-grid:25:675:6575', classFill(2)],
    ],
  );
  assert.equal(layer.getRowControls().legend.length, 7);
  assert.match(layer.getRowControls().info, /^25 km squares/);

  state.picked = {
    set: 'population-grid:sums',
    id: 'population-grid:25:675:6575',
  };
  state.click();
  const [card] = shown.get('population-grid');
  assert.equal(card.title, 'POPULATION · 25 km square');
  assert.deepEqual(card.details.slice(0, 2), [
    'about 4,320 people',
    '6.9 per km²',
  ]);
  const [outline] = items('selected');
  assert.equal(outline.positions.length, 5, 'closed square');
  assert.equal(
    picking.findPickOwner('population-grid:25:650:6575'),
    POPULATION_GRID_LAYER_ID,
  );
  // A square with fewer than 5 people tells no number.
  state.picked = {
    set: 'population-grid:sums',
    id: 'population-grid:25:650:6575',
  };
  state.click();
  assert.deepEqual(shown.get('population-grid')[0].details.slice(0, 2), [
    'fewer than 5 people',
    'under 1 per km²',
  ]);
  // A click on bare ground closes it.
  state.picked = null;
  state.click();
  assert.deepEqual(shown.get('population-grid'), []);
  assert.deepEqual(items('selected'), []);

  const records = layer.getAnalystRecords();
  assert.deepEqual(
    records.map(({ id, people, peoplePerKm2, fewerThan5 }) => [
      id,
      people,
      peoplePerKm2,
      fewerThan5,
    ]),
    [
      ['population-25km-650-6575', null, null, true],
      ['population-25km-675-6575', 4320, 6.9, false],
    ],
  );
  assert.equal(records[1].name, '25 km square');
  assert.ok(records[1].lat > 59 && records[1].lon > 17);
  layer.disable();
  assert.equal(state.click, null, 'no clicks while off');
});

test('zooming in reads again at the finer square size', async (t) => {
  const { layer, state, camera, items } = harness(t, { rect: WIDE });
  layer.enable();
  await layer.update();
  assert.equal(items('sums').length, 2);
  camera.setViewRectangle(CLOSE);
  await layer.update();
  assert.equal(state.reads.length, 2, 'inside the wide box, but finer');
  assert.equal(items('squares').length, 2);
  assert.deepEqual(items('sums'), []);
});

test('a capped view says how many squares it shows', async (t) => {
  const { layer } = harness(t, { capped: true });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    '1 km squares (Source: SCB). The 2 squares nearest the centre are shown.',
  );
});

test('a view from too high reads nothing', async (t) => {
  const { layer, state, items } = harness(t, { height: 5_000_000 });
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 0);
  assert.deepEqual(items('squares'), []);
});
