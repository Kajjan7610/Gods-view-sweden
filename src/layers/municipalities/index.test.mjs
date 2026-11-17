// The municipality layer on the renderer's ports: border lines in a few
// batched line sets, draped on the surface the map shows, names for the
// view, and a card for a municipality clicked on the ground.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  MUNICIPALITIES_OVERLAY_SOURCE_ID,
  MUNICIPALITY_LABELS_SOURCE_ID,
  createMunicipalitiesLayer,
  encodeLine,
} from './index.js';

// Two municipalities side by side in one county, sharing the line x = 18.1;
// their other sides are county border, and a sea border is left out.
const LINES = [
  {
    k: 'm',
    p: encodeLine([
      [18.1, 59.3],
      [18.1, 59.4],
    ]),
  },
  {
    k: 'c',
    p: encodeLine([
      [18.1, 59.4],
      [18.0, 59.4],
      [18.0, 59.3],
      [18.1, 59.3],
    ]),
  },
  {
    k: 'c',
    p: encodeLine([
      [18.1, 59.3],
      [18.2, 59.3],
      [18.2, 59.4],
      [18.1, 59.4],
    ]),
  },
  {
    k: 'c',
    s: 1,
    p: encodeLine([
      [18.2, 59.3],
      [18.3, 59.3],
    ]),
  },
];
const municipality = (code, name, rings, label) => ({
  code,
  name,
  county: '01',
  label,
  rings,
  population: 100_000,
  populationYearAgo: 99_000,
});
const SNAPSHOT = {
  osmBase: '2026-11-01T00:00:00Z',
  populationPeriod: '2026M09',
  lines: LINES,
  municipalities: [
    municipality('0180', 'Väst', [[1, 2]], [18.05, 59.35]),
    municipality('0181', 'Öst', [[-1, 3]], [18.15, 59.35]),
  ],
  counties: [{ code: '01', name: 'Stockholms län', label: [18.1, 59.36] }],
};
const MUNICIPAL_COLOR = [0x80 / 255, 0xde / 255, 0xea / 255, 0.85];
const COUNTY_COLOR = [0xff / 255, 0xd5 / 255, 0x4f / 255, 0.85];

function harness(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = {
    globeVisible: true,
    entries: new Map(),
    cardHit: null,
    click: null,
    topHit: null,
    ground: null,
    renders: 0,
  };
  const flights = [];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 18.1, lat: 59.35, height: 50_000 },
    viewRectangle: { west: 17.9, south: 59.2, east: 18.3, north: 59.5 },
  });
  camera.port.flyTo = (destination, options) => {
    flights.push({ destination, options });
    return { done: Promise.resolve('complete'), cancel() {} };
  };
  let centre = [18.05, 59.35];
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: {
      pickEllipsoid: () => (centre ? fromDegrees(centre[0], centre[1]) : null),
    },
    globe: { isGlobeVisible: () => state.globeVisible },
    frame: { requestRender: () => (state.renders += 1) },
  });
  const stack = new EventTarget();
  const layer = createMunicipalitiesLayer({
    source: { getSnapshot: async () => SNAPSHOT },
    overlayHost: {
      setEntries: (id, entries) => state.entries.set(id, entries),
      setVisible() {},
      clearSource: (id) => state.entries.delete(id),
      hitTest: () => state.cardHit,
    },
    mapStackEventTarget: stack,
    // The globe's clicks: what is on top under them, and the ground there.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 1, y: 1 },
            topHit: state.topHit,
            ground: () =>
              state.ground
                ? fromDegrees(state.ground[0], state.ground[1])
                : null,
          });
        return () => (state.click = null);
      },
    }),
  });
  layer.init(viewer);
  const set = (name) => draw.set(`municipalities:${name}`);
  const items = (name) => [...(set(name)?.items.values() ?? [])];
  const card = () => state.entries.get(MUNICIPALITIES_OVERLAY_SOURCE_ID);
  const labels = () =>
    (state.entries.get(MUNICIPALITY_LABELS_SOURCE_ID) ?? []).map(
      (entry) => entry.title,
    );
  return {
    layer,
    state,
    camera,
    draw,
    set,
    items,
    card,
    labels,
    flights,
    stack,
    moveCentre: (next) => (centre = next),
  };
}

const chip = (layer, id) =>
  layer.getRowControls().chips.find((entry) => entry.id === id);

test('the borders are a few line sets, shown only while the layer is on', async (t) => {
  const { layer, draw, set, items, state } = harness(t);
  const ids = [...draw.sets.keys()];
  assert.deepEqual(ids, [
    'municipalities:municipality',
    'municipalities:county',
    'municipalities:countyAsMunicipality',
    'municipalities:selected',
  ]);
  for (const id of ids) {
    assert.equal(draw.set(id).kind, 'lines');
    assert.equal(draw.set(id).show, false);
    assert.equal(draw.set(id).spec.clampTo, 'terrain');
  }
  layer.enable();
  assert.equal(await layer.update(), true);
  // One write per set: the lines are batched, not one set each.
  assert.equal(set('municipality').writes, 1);
  assert.equal(set('county').writes, 1);
  assert.deepEqual(
    items('municipality').map((line) => line.id),
    ['municipality-border:0'],
  );
  // The sea border is left out.
  assert.deepEqual(
    items('county').map((line) => line.id),
    ['municipality-border:1', 'municipality-border:2'],
  );
  const [municipal] = items('municipality');
  assert.equal(municipal.mode, 'draped');
  assert.equal(municipal.widthPx, 1.2);
  assert.deepEqual(municipal.style, { kind: 'solid', color: MUNICIPAL_COLOR });
  assert.equal(municipal.positions.length, 2 * 3, 'packed x, y, z');
  const [county] = items('county');
  assert.equal(county.widthPx, 2.5);
  assert.deepEqual(county.style, { kind: 'solid', color: COUNTY_COLOR });
  assert.equal(set('municipality').show, true);
  assert.equal(set('county').show, true);
  // The counties' lines as municipal ones are not built while counties show.
  assert.equal(set('countyAsMunicipality').items.size, 0);
  assert.equal(set('countyAsMunicipality').show, false);
  assert.equal(set('selected').show, true);
  assert.ok(state.renders > 0, 'a frame is asked for');
  assert.equal(layer.getStats().count, 2);

  layer.disable();
  for (const name of ['municipality', 'county', 'countyAsMunicipality'])
    assert.equal(set(name).show, false, name);
  assert.equal(set('selected').show, false);
  // The lines stay built for the next time.
  assert.equal(set('county').items.size, 2);
  layer.destroy();
  assert.equal(draw.find('municipalities:'), undefined, 'all disposed');
});

test('with the counties hidden their lines draw as municipal ones', async (t) => {
  const { layer, set, items } = harness(t);
  layer.enable();
  await layer.update();
  chip(layer, 'boundary-county').onClick();
  assert.equal(set('county').show, false);
  assert.equal(set('countyAsMunicipality').show, true);
  assert.deepEqual(
    items('countyAsMunicipality').map((line) => [line.id, line.widthPx]),
    [
      ['municipality-border:1', 1.2],
      ['municipality-border:2', 1.2],
    ],
  );
  assert.deepEqual(
    items('countyAsMunicipality')[0].style.color,
    MUNICIPAL_COLOR,
  );
  assert.deepEqual(
    layer.getRowControls().legend.map((entry) => entry.label),
    ['Municipal border'],
  );
  // Back again: nothing is built twice.
  chip(layer, 'boundary-county').onClick();
  assert.equal(set('county').show, true);
  assert.equal(set('countyAsMunicipality').show, false);
  chip(layer, 'boundary-county').onClick();
  assert.equal(set('countyAsMunicipality').writes, 1);
  // Municipal borders off too: nothing shows.
  chip(layer, 'boundary-municipality').onClick();
  for (const name of ['municipality', 'county', 'countyAsMunicipality'])
    assert.equal(set(name).show, false, name);
});

test('the lines follow the map stack to the surface it shows', async (t) => {
  const { layer, draw, state, stack } = harness(t);
  const clamps = () =>
    [...draw.sets.values()].map((record) => record.spec.clampTo);
  layer.enable();
  await layer.update();
  state.globeVisible = false;
  stack.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.deepEqual(clamps(), ['tiles', 'tiles', 'tiles', 'tiles']);
  // While off, the change waits for enable().
  layer.disable();
  state.globeVisible = true;
  stack.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.deepEqual(clamps(), ['tiles', 'tiles', 'tiles', 'tiles']);
  layer.enable();
  assert.deepEqual(clamps(), ['terrain', 'terrain', 'terrain', 'terrain']);
  layer.destroy();
  // A removed listener: a later change touches nothing.
  stack.dispatchEvent(new Event('gev:map-stack-changed'));
});

test('a click on the ground selects the municipality there; again lets go', async (t) => {
  const { layer, state, card, items, labels } = harness(t);
  layer.enable();
  await layer.update();
  state.ground = [18.15, 59.35];
  state.click();
  assert.equal(card()[0].title, 'MUNICIPALITY · Öst');
  // Its outline, apart from the borders.
  const [outline] = items('selected');
  assert.equal(outline.widthPx, 4);
  assert.equal(outline.mode, 'draped');
  assert.deepEqual(outline.style, { kind: 'solid', color: [1, 1, 1, 0.9] });
  assert.equal(outline.positions.length, 5 * 3);
  // The selected one's name gives way to its card.
  t.mock.timers.tick(400);
  assert.ok(!labels().includes('Öst'));

  // A click on one of the layer's own lines is a click on the ground.
  state.topHit = {
    set: 'municipalities:municipality',
    id: 'municipality-border:0',
    surface: false,
  };
  state.ground = [18.05, 59.35];
  state.click();
  assert.equal(card()[0].title, 'MUNICIPALITY · Väst');
  // Another layer's object is that layer's to select.
  state.topHit = {
    set: 'fire-stations',
    id: 'se-fire-station:1',
    surface: false,
  };
  state.ground = [18.15, 59.35];
  state.click();
  assert.equal(card()[0].title, 'MUNICIPALITY · Väst');
  // A card under the click, this layer's or another's, is not the ground.
  state.topHit = null;
  state.cardHit = { sourceId: 'hospitals', entryId: 'x' };
  state.click();
  assert.equal(card()[0].title, 'MUNICIPALITY · Väst');
  state.cardHit = null;
  // The same municipality again lets go.
  state.ground = [18.05, 59.35];
  state.click();
  assert.deepEqual(card(), []);
  assert.deepEqual(items('selected'), []);
  // Over the sky nothing happens; outside every municipality nothing is chosen.
  state.ground = null;
  state.click();
  state.ground = [17.0, 59.35];
  state.click();
  assert.deepEqual(card(), []);

  layer.disable();
  assert.equal(state.click, null, 'no clicks while off');
});

test('names follow the view: counties from high up, municipalities lower', async (t) => {
  const { layer, camera, labels, moveCentre } = harness(t);
  layer.enable();
  await layer.update();
  assert.deepEqual(labels(), ['Väst', 'Öst']);
  assert.equal(
    layer.getRowControls().info,
    'Map centre: Väst, Stockholms län · 100,000 people (+1.0 % in a year)',
  );
  camera.setPose({ height: 400_000 });
  moveCentre([18.15, 59.35]);
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  assert.deepEqual(labels(), ['Stockholms län']);
  assert.match(layer.getRowControls().info, /^Map centre: Öst/);
  layer.disable();
  assert.deepEqual(labels(), []);
  assert.equal(layer.getRowControls().info, '');
  assert.equal(camera.listenerCount('moveEnd'), 0);
  assert.equal(camera.listenerCount('changed'), 0);
});

test('a municipality is selected by its code and flown over', async (t) => {
  const { layer, card, flights } = harness(t);
  assert.equal(layer.setParams({ municipalityCode: '0181' }), false);
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ municipalityCode: 'nope' }), false);
  assert.equal(
    layer.setParams({ municipalityCode: '0181', focus: true }),
    true,
  );
  assert.equal(card()[0].title, 'MUNICIPALITY · Öst');
  assert.deepEqual(flights, [
    {
      destination: { lon: 18.15, lat: 59.35, height: 60_000 },
      options: { durationS: 1.8 },
    },
  ]);
});
