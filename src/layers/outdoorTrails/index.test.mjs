// The outdoor trails layer: read for low views only, trails as lines and
// facilities as dots, one card at a time, and what the analyst reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  FACILITY_CLASS,
  OUTDOOR_TRAILS_LINES_SET_ID,
  OUTDOOR_TRAILS_OVERLAY_SOURCE_ID,
  OUTDOOR_TRAILS_POINTS_SET_ID,
  createOutdoorTrailsLayer,
} from './index.js';
import { encodeLine } from '../municipalities/records.js';

const FACILITIES = [
  {
    id: '11',
    point: [18.27, 59.176],
    name: 'Vindskyddet vid Stensjön',
    type: 'Vindskydd',
    subtype: null,
    kind: 'shelter',
    accessible: false,
    description: 'Vindskydd med eldstad.',
    area: 'Tyresta',
    stateTrail: false,
    distance: 50,
  },
  {
    id: '12',
    point: [18.21, 59.16],
    name: null,
    type: 'Parkering',
    subtype: 'Parkering för rörelsehindrade',
    kind: 'access',
    accessible: true,
    description: null,
    area: 'Tyresta',
    stateTrail: false,
    distance: 4000,
  },
];
const TRAILS = [
  {
    id: 'l7',
    name: 'Sörmlandsleden',
    type: 'Vandringsled',
    category: null,
    kind: 'hike',
    marking: 'Orange',
    description: 'En del av Sörmlandsleden.',
    area: 'Tyresta',
    stateTrail: false,
    lengthKm: 12.5,
    anchor: [18.28, 59.175],
    distance: 30,
    lines: [
      encodeLine([
        [18.25, 59.17],
        [18.28, 59.175],
      ]),
      encodeLine([
        [18.29, 59.176],
        [18.31, 59.18],
      ]),
    ],
  },
];

function harness({ height = 8000, answer = {} } = {}) {
  const reads = [];
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 18.27, lat: 59.17, height },
    viewRectangle: { west: 18.2, south: 59.15, east: 18.35, north: 59.2 },
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => fromDegrees(18.27, 59.175) },
  });
  const layer = createOutdoorTrailsLayer({
    source: {
      getSnapshot: async (query) => {
        reads.push(query);
        if (reads.fail) throw reads.fail;
        return {
          facilities: FACILITIES,
          trails: TRAILS,
          facilityTotal: 2,
          trailTotal: 1,
          tooWide: false,
          capped: false,
          stale: false,
          fetchedAt: Date.parse('2026-11-19T12:00:00Z'),
          ...answer,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, OUTDOOR_TRAILS_OVERLAY_SOURCE_ID);
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
              ? { set: 'outdoor-trails', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
  });
  layer.init(viewer);
  const lines = () => draw.set(OUTDOOR_TRAILS_LINES_SET_ID);
  const dots = () => draw.set(OUTDOOR_TRAILS_POINTS_SET_ID);
  const items = (set) => [...(set()?.items.values() ?? [])];
  return { layer, camera, state, reads, lines, dots, items };
}

test('trails are lines and facilities dots, shown only while the layer is on', async () => {
  const { layer, lines, dots, state } = harness();
  assert.equal(lines().kind, 'lines');
  assert.equal(lines().spec.clampTo, 'both');
  assert.equal(dots().kind, 'points');
  assert.equal(dots().spec.horizonCull, true);
  assert.equal(lines().show, false);
  layer.enable();
  assert.equal(lines().show, true);
  assert.equal(dots().show, true);
  layer.disable();
  assert.equal(dots().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
  assert.equal(lines(), undefined, 'the sets are disposed');
});

test('a low view reads its clipped box and draws each line and dot', async () => {
  const { layer, reads, lines, dots, items } = harness();
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 1);
  const [w, s, e, n] = reads[0].bbox;
  assert.ok(e - w <= 0.4 + 1e-9 && n - s <= 0.4 + 1e-9);
  assert.equal(reads[0].limit, 1500);
  const drawnLines = items(lines);
  assert.deepEqual(
    drawnLines.map((item) => item.id),
    ['se-outdoor:t:l7:0', 'se-outdoor:t:l7:1'],
  );
  assert.equal(drawnLines[0].mode, 'draped');
  assert.equal(drawnLines[0].widthPx, 2.5);
  assert.equal(drawnLines[0].positions.length, 2);
  const drawnDots = items(dots);
  assert.equal(drawnDots.length, 2);
  const shelter = drawnDots.find((item) => item.id === 'se-outdoor:f:11');
  assert.equal(shelter.color, FACILITY_CLASS.shelter.color);
  assert.equal(shelter.pixelSize, 9);
  assert.equal(shelter.height, 'clampGround');
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => `${label} ${count}`),
    [
      'Hiking trails 1',
      'Shelters and cabins 1',
      'Parking, jetties and swimming 1',
    ],
  );
  assert.match(controls.legend[0].blurb, /Only published areas are covered/);
  assert.match(controls.legend[0].blurb, /Reserve rules and access bans/);
  assert.equal(controls.info, 'In view: 1 trails · 2 facilities');
  assert.equal(layer.getStats().count, 3);
  layer.destroy();
});

test('a high view reads nothing and asks to zoom in', async () => {
  const { layer, reads, items, dots } = harness({ height: 80_000 });
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(items(dots).length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see the trails and facilities: they show below 30 km',
  );
  assert.equal(layer.getStats().count, null);
});

test('a camera move reads the view again once it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, camera, reads, items, lines } = harness();
  layer.enable();
  await layer.update();
  camera.setPose({ height: 80_000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  assert.equal(items(lines).length, 0);
  camera.setPose({ height: 5000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2);
  assert.equal(items(lines).length, 2);
  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  layer.destroy();
});

test('a view seen from 30 km is asked as a whole; an empty one says why', async () => {
  const { layer, camera, reads } = harness({
    height: 30_000,
    answer: { facilities: [], trails: [], facilityTotal: 0, trailTotal: 0 },
  });
  // Straight down from 30 km: 0.7° of longitude here, more than 0.4°.
  const view = { west: 17.92, south: 59.09, east: 18.62, north: 59.26 };
  camera.setViewRectangle(view);
  layer.enable();
  await layer.update();
  assert.deepEqual(reads[0].bbox, [
    view.west,
    view.south,
    view.east,
    view.north,
  ]);
  const controls = layer.getRowControls();
  assert.deepEqual(controls.legend, []);
  assert.equal(
    controls.info,
    'Nothing published in view. Only protected areas whose managers publish their trails and facilities are covered, plus the state mountain trails.',
  );
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});

test('a read that failed is not said to have found nothing', async () => {
  const { layer, camera, reads } = harness({
    answer: { facilities: [], trails: [], facilityTotal: 0, trailTotal: 0 },
  });
  layer.enable();
  await layer.update();
  assert.match(layer.getRowControls().info, /^Nothing published in view/);
  // The next view's read fails: the row has the error, not the empty note.
  reads.fail = new Error('Trails unavailable (HTTP 502)');
  camera.setPose({ lon: 18.3 });
  await layer.update();
  assert.equal(layer.getStats().error, 'Trails unavailable (HTTP 502)');
  assert.equal(layer.getRowControls().info, '');
  layer.destroy();
});

test('a capped view asks to zoom in for the rest', async () => {
  const { layer } = harness({ answer: { capped: true } });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see every trail and facility here.',
  );
});

test('one card at a time: a trail, then a facility, then the ground', async () => {
  const { layer, state, items, lines } = harness();
  layer.enable();
  await layer.update();
  state.picked = 'se-outdoor:t:l7:1';
  state.click();
  assert.equal(state.cards.length, 1);
  const trailCard = state.cards[0];
  assert.equal(trailCard.title, 'TRAIL · SÖRMLANDSLEDEN');
  const text = trailCard.details.join(' ');
  assert.match(text, /Length 12\.5 km/);
  assert.match(text, /Marking: Orange/);
  assert.match(text, /Protected area: Tyresta/);
  assert.match(text, /Source: Naturvårdsverket/);
  assert.ok(trailCard.position, 'the card sits on the trail');
  assert.ok(
    items(lines).every((item) => item.widthPx === 5),
    'the selected trail is drawn wider',
  );

  state.picked = 'se-outdoor:f:12';
  const writes = lines().writes;
  state.click();
  assert.equal(lines().writes, writes + 1, 'one write, not a redraw');
  assert.equal(state.cards.length, 1);
  assert.equal(
    state.cards[0].title,
    'FACILITY · PARKERING FÖR RÖRELSEHINDRADE',
  );
  assert.match(
    state.cards[0].details.join(' '),
    /Adapted for reduced mobility/,
  );
  assert.ok(items(lines).every((item) => item.widthPx === 2.5));

  // A click on a card is not the ground.
  state.cardHit = { sourceId: 'hospitals', entryId: 'x' };
  state.picked = null;
  state.click();
  assert.equal(state.cards.length, 1);
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    state.picked = 'se-hospital:1';
    state.click();
    assert.equal(
      state.cards.length,
      1,
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('an open card is rebuilt when the language changes', async () => {
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ facilityId: '11' }), true);
  const first = state.cards[0];
  const { setLocale } = await import('../../i18n/index.js');
  try {
    await setLocale('sv');
    assert.notEqual(state.cards[0], first, 'a new card was published');
  } finally {
    await setLocale('en');
  }
  layer.destroy();
});

test('a click redraws only the trail let go and the trail taken', async () => {
  const other = {
    ...TRAILS[0],
    id: 'l8',
    name: 'Annan led',
    lines: [
      encodeLine([
        [18.3, 59.18],
        [18.32, 59.19],
      ]),
    ],
  };
  const { layer, state, lines } = harness({
    answer: { trails: [TRAILS[0], other], trailTotal: 2 },
  });
  layer.enable();
  await layer.update();
  const untouched = lines().items.get('se-outdoor:t:l8:0');
  const writes = lines().writes;
  state.picked = 'se-outdoor:t:l7:0';
  state.click();
  assert.equal(lines().writes, writes + 1);
  assert.equal(lines().items.size, 3, 'every line is still there');
  assert.equal(lines().items.get('se-outdoor:t:l7:0').widthPx, 5);
  assert.equal(
    lines().items.get('se-outdoor:t:l8:0'),
    untouched,
    'the other trail is not drawn again',
  );
  state.picked = 'se-outdoor:t:l8:0';
  state.click();
  assert.equal(lines().items.get('se-outdoor:t:l7:0').widthPx, 2.5);
  assert.equal(lines().items.get('se-outdoor:t:l8:0').widthPx, 5);
  layer.destroy();
});

test('findByQuery names a picked trail or facility and says where it is', async () => {
  const { layer } = harness();
  layer.enable();
  await layer.update();
  assert.deepEqual(layer.findByQuery('se-outdoor:t:l7:0'), {
    name: 'Trail · Sörmlandsleden',
    latitude: 59.175,
    longitude: 18.28,
  });
  assert.deepEqual(layer.findByQuery('se-outdoor:f:12'), {
    name: 'Facility · Parkering för rörelsehindrade',
    latitude: 59.16,
    longitude: 18.21,
  });
  assert.equal(layer.findByQuery('se-outdoor:f:nope'), null);
  assert.equal(layer.findByQuery('se-hospital:1'), null);
  layer.destroy();
});

test('the analyst reads trails then facilities, and nothing while off', async () => {
  const { layer } = harness();
  layer.enable();
  await layer.update();
  const records = layer.getAnalystRecords();
  assert.deepEqual(
    records.map((r) => [r.name, r.lat, r.lon]),
    [
      ['Trail · Sörmlandsleden', 59.175, 18.28],
      ['Facility · Vindskyddet vid Stensjön', 59.176, 18.27],
      ['Facility · Parkering för rörelsehindrade', 59.16, 18.21],
    ],
  );
  assert.equal(records[0].lengthKm, 12.5);
  assert.equal(records[0].kind, 'Vandringsled');
  assert.equal(records[2].accessible, true);
  assert.equal(layer.getAnalystRecords(1).length, 1);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy();
});
