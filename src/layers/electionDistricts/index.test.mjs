// The election district layer's life: districts read for low views only,
// drawn as one batch, coloured by party or turnout, and a card on a click.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createElectionDistrictsLayer } from './index.js';
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
  const state = { height, reads: [], picked: undefined, click: null };
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
        Cesium.Rectangle.fromDegrees(17.9, 59.25, 18.2, 59.4),
      moveEnd: { addEventListener: () => () => {} },
      changed: { addEventListener: () => () => {} },
    },
  };
  const shown = new Map();
  const layer = createElectionDistrictsLayer({
    source: {
      getDistricts: async ({ bbox }) => {
        state.reads.push(bbox);
        return {
          districts: [
            district('01800101', 18.0, 59.3, [300, 250, 200, 50, 50, 50, 50, 40, 10], 900),
            district('01800102', 18.05, 59.32, [200, 350, 200, 50, 50, 50, 50, 40, 10], 760),
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
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
  });
  layer.init(viewer);
  // Areas and their outlines are the first data source.
  const drawn = () => sources[0].entities.values.length;
  const areas = () =>
    sources[0].entities.values
      .filter((entity) => entity.polygon)
      .map((entity) => [
        entity.id,
        entity.polygon.material.color.getValue().toCssHexString(),
      ]);
  return { layer, state, drawn, areas, shown };
}

const legendLabels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);

test('a low view reads and draws its districts, coloured by largest party', async (t) => {
  const { layer, state, drawn, areas } = harness(t);
  layer.enable();
  await layer.update();
  assert.equal(state.reads.length, 1);
  // The view box, padded a quarter on each side.
  const [w, s, e, n] = state.reads[0];
  assert.ok(w < 17.9 && s < 59.25 && e > 18.2 && n > 59.4);
  assert.equal(drawn(), 4, 'an area and an outline per district');
  assert.deepEqual(legendLabels(layer), ['S 1', 'M 1']);
  const partyAreas = areas();
  assert.deepEqual(
    partyAreas.map(([, color]) => color),
    ['#ed1b3473', '#52bdec73'],
  );
  assert.equal(layer.getStats().count, 2);
  // The same view again: nothing new to read.
  await layer.update();
  assert.equal(state.reads.length, 1);
  layer
    .getRowControls()
    .chips.find(({ id }) => id === 'turnout')
    .onClick();
  assert.deepEqual(legendLabels(layer), ['70 to 80 % 1', '90 % and above 1']);
  // Drawn anew under new ids: Cesium keeps an entity re-added under its old
  // id in its old colour.
  const before = new Set(partyAreas.map(([id]) => id));
  assert.deepEqual(
    areas().map(([id, color]) => [before.has(id), color]),
    [
      [false, '#fde72573'],
      [false, '#3b528b73'],
    ],
  );
  layer.disable();
  assert.equal(drawn(), 0);
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

test('a click on a district shows its card; a click on the map clears it', async (t) => {
  const { layer, state, shown } = harness(t);
  layer.enable();
  await layer.update();
  state.picked = { id: { id: 'election-district:01800102:0' } };
  state.click({ position: { x: 1, y: 1 } });
  const [card] = shown.get('election-districts');
  assert.equal(card.title, 'ELECTION DISTRICT · District 01800102');
  assert.equal(
    layer.districtAt([18.055, 59.325])?.c,
    '01800102',
  );
  state.picked = undefined;
  state.click({ position: { x: 1, y: 1 } });
  assert.deepEqual(shown.get('election-districts'), []);
});
