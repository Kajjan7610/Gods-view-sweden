// The hospitals layer: one set of dots coloured by the emergency figures,
// cards on a click, the list that follows the camera, and the flight to a row.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  HOSPITALS_OVERLAY_SOURCE_ID,
  HOSPITAL_COLOR,
  createHospitalsLayer,
  hospitalColor,
} from './index.js';

const statistics = { year: 2025, national: { ttl2025: 61, tvt2025: 256 } };
const hospital = (id, point, extra = {}) => ({
  id,
  name: `Sjukhus ${id}`,
  point,
  ed: null,
  ...extra,
});
// North: a short time to physician but a long stay; south: a plain hospital,
// and a department further south still.
const ROWS = [
  hospital('n', [18.0, 59.4], { ed: { ttl2025: 40, tvt2025: 320 } }),
  hospital('p', [18.0, 59.3], { height: 22 }),
  hospital('s', [18.0, 59.2], { ed: { ttl2025: 60, tvt2025: 250 } }),
];

function harness() {
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const flights = [];
  let centre = [18.0, 59.41];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 18.0, lat: 59.3, height: 50_000 },
    viewRectangle: { west: 17.5, south: 59.0, east: 18.5, north: 59.6 },
  });
  camera.port.flyTo = (destination, options) => {
    flights.push({ destination, options });
    return { done: Promise.resolve('complete'), cancel() {} };
  };
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: {
      pickEllipsoid: () => (centre ? fromDegrees(centre[0], centre[1]) : null),
    },
  });
  const layer = createHospitalsLayer({
    source: {
      getSnapshot: async () => ({
        hospitals: ROWS,
        statistics,
        osmBase: '2026-11-01T00:00:00Z',
      }),
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, HOSPITALS_OVERLAY_SOURCE_ID);
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
              ? { set: 'hospitals', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
  });
  layer.init(viewer);
  const set = () => draw.find('hospitals');
  const dots = () => [...(set()?.items.values() ?? [])];
  return {
    layer,
    camera,
    state,
    flights,
    set,
    dots,
    moveCentre: (next) => (centre = next),
  };
}

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('the hospitals are one set of dots, shown only while the layer is on', async (t) => {
  quiet(t);
  const { layer, set, dots, state, camera } = harness();
  assert.equal(set().kind, 'points');
  assert.equal(set().show, false);
  // Terrain only, with the bundled height: 3D tiles freeze the app.
  assert.equal(set().spec.clampTo, 'terrain');
  assert.equal(set().spec.horizonCull, true);
  layer.enable();
  assert.equal(set().show, true);
  assert.equal(await layer.update(), true);
  assert.equal(dots().length, 3);
  assert.equal(layer.getStats().count, 3);
  layer.disable();
  assert.equal(set().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  assert.equal(camera.listenerCount('moveEnd'), 0);
  assert.equal(camera.listenerCount('changed'), 0);
  layer.destroy();
  assert.equal(set(), undefined, 'the set is disposed');
});

test('a dot is coloured by its figure, departments larger and drawn last', async (t) => {
  quiet(t);
  const { layer, dots } = harness();
  layer.enable();
  await layer.update();
  assert.deepEqual(
    dots().map((item) => item.id),
    ['se-hospital:p', 'se-hospital:n', 'se-hospital:s'],
  );
  const [plain, north] = dots();
  assert.equal(plain.pixelSize, 7);
  assert.equal(plain.outlineWidth, 1.5);
  assert.equal(plain.color, HOSPITAL_COLOR);
  assert.deepEqual(plain.pos, { lon: 18.0, lat: 59.3, height: 22 });
  assert.equal(north.pixelSize, 11);
  assert.equal(north.outlineWidth, 2);
  assert.equal(north.outlineColor, '#3b0d0d');
  assert.equal(north.height, 'clampGround');
  assert.deepEqual(north.pos, { lon: 18.0, lat: 59.4, height: 0 });
  assert.equal(north.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(north.scaleByDistance, {
    near: 2e4,
    nearValue: 1.3,
    far: 2e6,
    farValue: 0.7,
  });
  assert.equal(north.color, hospitalColor(ROWS[0], 'ttl', statistics));

  // The other figure colours the same dots anew.
  const total = layer
    .getRowControls()
    .segmented.options.find((option) => option.id === 'metric-tvt');
  total.onClick();
  const recoloured = dots().find((item) => item.id === 'se-hospital:n');
  assert.equal(recoloured.color, hospitalColor(ROWS[0], 'tvt', statistics));
  assert.notEqual(recoloured.color, north.color);
  layer.destroy();
});

test('a click on a dot opens its card; the ground closes it', async (t) => {
  quiet(t);
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  state.picked = 'se-hospital:n';
  state.click();
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].id, 'hospitals-card:n');
  assert.ok(state.cards[0].position, 'the card sits on the hospital');
  assert.equal(
    layer.getRowControls().list.items.find((item) => item.id === 'n').active,
    true,
  );
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test("a click on another layer's card or dot leaves the open card alone", async (t) => {
  quiet(t);
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  state.picked = 'se-hospital:n';
  state.click();
  state.cardHit = { sourceId: 'fire-stations', entryId: 'x' };
  state.picked = null;
  state.click();
  assert.equal(
    state.cards[0]?.id,
    'hospitals-card:n',
    'a card is not the ground',
  );
  state.cardHit = null;
  picking.registerPickOwner('fire-stations', (id) =>
    id.startsWith('se-fire-station:'),
  );
  try {
    state.picked = 'se-fire-station:1';
    state.click();
    assert.equal(
      state.cards[0]?.id,
      'hospitals-card:n',
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('fire-stations');
  }
  layer.destroy();
});

test('the list follows the map centre once the camera settles', async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, camera, moveCentre } = harness();
  layer.enable();
  assert.equal(camera.listenerCount('moveEnd'), 1);
  assert.equal(camera.listenerCount('changed'), 1);
  await layer.update();
  const listed = () => layer.getRowControls().list.items.map((item) => item.id);
  assert.deepEqual(listed(), ['n', 's'], 'nearest the centre in the north');

  moveCentre([18.0, 59.19]);
  camera.emit('moveEnd');
  t.mock.timers.tick(399);
  assert.deepEqual(listed(), ['n', 's'], 'not before the move settles');
  t.mock.timers.tick(1);
  assert.deepEqual(listed(), ['s', 'n']);

  // A jump that ends no move: `changed` catches it.
  moveCentre([18.0, 59.41]);
  camera.emit('changed');
  t.mock.timers.tick(400);
  assert.deepEqual(listed(), ['n', 's']);

  // Off the globe the centre is the point under the eye.
  moveCentre(null);
  camera.setPose({ lon: 18.0, lat: 59.21 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  assert.deepEqual(listed(), ['s', 'n']);
  layer.destroy();
});

test('a row of the list selects its hospital and flies to it', async (t) => {
  quiet(t);
  const { layer, state, flights } = harness();
  layer.enable();
  await layer.update();
  const row = layer.getRowControls().list.items[0];
  assert.equal(layer.setParams(row.params), true);
  assert.equal(state.cards[0].id, `hospitals-card:${row.id}`);
  assert.equal(flights.length, 1);
  const [{ destination, options }] = flights;
  assert.equal(destination.lon, 18.0);
  assert.ok(Math.abs(destination.lat - (59.4 - 0.012)) < 1e-12);
  assert.equal(destination.height, 1400);
  assert.deepEqual(options, {
    orientation: { heading: 0, pitch: -45 * (Math.PI / 180), roll: 0 },
    durationS: 1.8,
  });
  // Without `focus` it only selects.
  assert.equal(layer.setParams({ hospitalId: 's' }), true);
  assert.equal(flights.length, 1);
  layer.destroy();
});
