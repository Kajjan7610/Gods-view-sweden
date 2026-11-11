import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { setLocale } from '../../i18n/index.js';
import { clearGroundHeightStore } from '../groundHeights.js';
import { POWER_GRID_OVERLAY_SOURCE_ID, createPowerGridLayer } from './index.js';

const LABEL_SOURCE_ID = 'power-grid-labels';
const UPDATED = Date.parse('2026-11-10T10:15:00Z');
const QUARTER_MS = 15 * 60_000;

const STOCKHOLM = [18.07, 59.33];
const LINKS = [
  {
    id: 'DE_SE4',
    from: 'DE',
    to: 'SE4',
    fromPoint: [12.1, 54.1],
    toPoint: [13.0, 55.6],
    mw: 188,
    kind: 'import',
  },
  {
    id: 'FI_SE3',
    from: 'SE3',
    to: 'FI',
    fromPoint: STOCKHOLM,
    toPoint: [21.51, 61.13],
    mw: 387,
    kind: 'export',
  },
  {
    id: 'SE2_SE3',
    from: 'SE2',
    to: 'SE3',
    fromPoint: [17.3, 62.39],
    toPoint: STOCKHOLM,
    mw: 5699,
    kind: 'internal',
  },
];

/** An answer as the source gives it; `extra` replaces whole fields. */
const snapshot = (extra = {}) => ({
  links: LINKS,
  areas: [
    { id: 'SE3', import: 5699, export: 387 },
    { id: 'SE4', import: 188, export: 0 },
  ],
  production: { at: UPDATED, total: 17468, consumption: 17888, wind: 9637 },
  updated: UPDATED,
  stale: false,
  fetchedAt: UPDATED,
  ...extra,
});
const withMw = (id, mw) =>
  LINKS.map((link) => (link.id === id ? { ...link, mw } : link));

/** A camera, as far as the layer looks at one, that a test can point. */
function fakeCamera() {
  const camera = {
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    positionWC: new Cesium.Cartesian3(),
    directionWC: new Cesium.Cartesian3(),
    upWC: new Cesium.Cartesian3(),
    frustum: new Cesium.PerspectiveFrustum({
      fov: Math.PI / 3,
      aspectRatio: 1.5,
      near: 1,
      far: 5e7,
    }),
    /** 3,000 km above a place, looking down at it, or up and away from it. */
    hover(lon, lat, { away = false } = {}) {
      Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        3_000_000,
        undefined,
        camera.positionWC,
      );
      Cesium.Cartesian3.normalize(camera.positionWC, camera.directionWC);
      if (!away)
        Cesium.Cartesian3.negate(camera.directionWC, camera.directionWC);
      const right = Cesium.Cartesian3.cross(
        camera.directionWC,
        Cesium.Cartesian3.UNIT_Z,
        new Cesium.Cartesian3(),
      );
      Cesium.Cartesian3.normalize(right, right);
      Cesium.Cartesian3.cross(right, camera.directionWC, camera.upWC);
    },
    overSweden: () => camera.hover(16, 61),
    farSide: () => camera.hover(-164, -61),
    lookAway: () => camera.hover(16, 61, { away: true }),
  };
  camera.overSweden();
  return camera;
}

/** A viewer, as far as the layer looks at one; it counts the entities added. */
function fakeViewer({ camera = null } = {}) {
  const sources = [];
  const viewer = {
    sources,
    adds: 0,
    picked: undefined,
    dataSources: {
      add(source) {
        const add = source.entities.add.bind(source.entities);
        source.entities.add = (entity) => {
          viewer.adds += 1;
          return add(entity);
        };
        sources.push(source);
      },
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
    scene: {
      mode: Cesium.SceneMode.SCENE3D,
      pick: () => viewer.picked,
      requestRender() {},
    },
  };
  if (camera) viewer.camera = camera;
  return viewer;
}

/** The layer with a card host, a click handler and a frame counter. */
function harness(t, source, { camera = null, ...options } = {}) {
  const viewer = fakeViewer({ camera });
  const state = {
    cards: [],
    cardPublishes: 0,
    labels: [],
    labelPublishes: 0,
    cardHit: null,
    click: null,
    frames: 0,
  };
  const layer = createPowerGridLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        if (sourceId === POWER_GRID_OVERLAY_SOURCE_ID) {
          state.cards = entries;
          state.cardPublishes += 1;
        } else {
          assert.equal(sourceId, LABEL_SOURCE_ID);
          state.labels = entries;
          state.labelPublishes += 1;
        }
      },
      clearSource(sourceId) {
        if (sourceId === POWER_GRID_OVERLAY_SOURCE_ID) state.cards = [];
        else state.labels = [];
      },
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
    requestRender: () => (state.frames += 1),
    ...options,
  });
  layer.init(viewer);
  // A failed assertion must not leave the ticker running.
  t.after(() => layer.destroy(viewer));
  const entities = () => viewer.sources[0].entities.values;
  const dot = (zone) =>
    entities().find((entity) => entity.id.startsWith(`se-kraftnat:${zone}:`));
  return { layer, viewer, state, entities, dot };
}

const CLICK = { position: { x: 10, y: 20 } };
const flowLabels = (state) =>
  state.labels
    .filter((entry) => entry.id.startsWith('power-grid-flow:'))
    .map((entry) => entry.id.slice('power-grid-flow:'.length))
    .sort();
const activeChip = (layer) =>
  layer.getRowControls().chips.find((chip) => chip.active)?.id;
const mockClock = (t) =>
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: UPDATED });

test('a click on a zone shows its card, and a click on the card keeps it', async (t) => {
  const { layer, viewer, state, dot } = harness(t, {
    getSnapshot: async () => snapshot(),
  });
  layer.enable();
  assert.equal(await layer.update(), true);

  viewer.picked = { id: dot('SE3').id };
  state.click(CLICK);
  assert.equal(state.cards.length, 1);
  const [card] = state.cards;
  assert.equal(card.id, 'power-grid-card:SE3');
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined, 'no page to open');
  assert.equal(card.accessibilityLabel, undefined);

  // On the card: it stays, and the dot under the card is not picked.
  viewer.picked = { id: dot('SE4').id };
  state.cardHit = { sourceId: POWER_GRID_OVERLAY_SOURCE_ID, entryId: card.id };
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, card.id, 'the selection stays');

  state.cardHit = null;
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'power-grid-card:SE4', 'beside the card');

  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
});

test("a click on another layer's card is not a click on the ground", async (t) => {
  const { layer, viewer, state, dot } = harness(t, {
    getSnapshot: async () => snapshot(),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: dot('SE3').id };
  state.click(CLICK);

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'power-grid-card:SE3', 'still selected');
  viewer.picked = { id: dot('SE4').id };
  state.click(CLICK);
  assert.equal(
    state.cards[0]?.id,
    'power-grid-card:SE3',
    'the zone behind the card is not selected',
  );
});

test('chevrons ask for frames only while lines with a flow are in view', async (t) => {
  mockClock(t);
  const camera = fakeCamera();
  const { layer, state } = harness(
    t,
    { getSnapshot: async () => snapshot() },
    { camera },
  );
  const framesIn = (ms) => {
    state.frames = 0;
    t.mock.timers.tick(ms);
    return state.frames;
  };
  assert.equal(framesIn(1000), 0, 'nothing before the layer is on');
  layer.enable();
  await layer.update();
  assert.equal(framesIn(330), 5);
  framesIn(3000);
  assert.equal(framesIn(660), 10, 'the flow goes on after the lines settled');

  camera.farSide();
  camera.changed.raiseEvent();
  assert.equal(framesIn(5000), 0, 'behind the globe');
  camera.overSweden();
  camera.moveEnd.raiseEvent();
  assert.equal(framesIn(660), 10, 'back in view');
  camera.lookAway();
  camera.changed.raiseEvent();
  assert.equal(framesIn(5000), 0, 'behind the camera');
  camera.overSweden();
  camera.changed.raiseEvent();
  assert.equal(framesIn(660), 10);

  layer.disable();
  assert.equal(framesIn(5000), 0, 'off');
  assert.equal(camera.changed.numberOfListeners, 0);
  assert.equal(camera.moveEnd.numberOfListeners, 0);

  layer.enable();
  assert.equal(camera.changed.numberOfListeners, 1);
  await layer.update();
  assert.equal(framesIn(660), 10, 'on again');
});

test('the camera is read on its events, never by the tick', async (t) => {
  mockClock(t);
  const camera = fakeCamera();
  let reads = 0;
  const frustum = camera.frustum;
  Object.defineProperty(camera, 'frustum', {
    get() {
      reads += 1;
      return frustum;
    },
  });
  const { layer, state } = harness(
    t,
    { getSnapshot: async () => snapshot() },
    { camera },
  );
  layer.enable();
  await layer.update();
  reads = 0;
  t.mock.timers.tick(10_000);
  assert.ok(state.frames > 100);
  assert.equal(reads, 0);
  camera.changed.raiseEvent();
  assert.equal(reads, 1);
});

test('where the view cannot be told the lines count as in view', async (t) => {
  mockClock(t);
  const camera = fakeCamera();
  camera.farSide();
  const { layer, viewer, state } = harness(
    t,
    { getSnapshot: async () => snapshot() },
    { camera },
  );
  viewer.scene.mode = Cesium.SceneMode.SCENE2D;
  layer.enable();
  await layer.update();
  t.mock.timers.tick(3000);
  state.frames = 0;
  t.mock.timers.tick(660);
  assert.equal(state.frames, 10);
});

test('without a flow to show the frames stop once the lines have settled', async (t) => {
  mockClock(t);
  let answer = snapshot({ links: LINKS.map((link) => ({ ...link, mw: 0 })) });
  const { layer, state } = harness(
    t,
    { getSnapshot: async () => answer },
    { camera: fakeCamera() },
  );
  const framesIn = (ms) => {
    state.frames = 0;
    t.mock.timers.tick(ms);
    return state.frames;
  };
  layer.enable();
  await layer.update();
  assert.equal(framesIn(5000), 0, 'no line drawn');

  answer = snapshot();
  await layer.update();
  framesIn(3000);
  assert.equal(framesIn(660), 10, 'a flow');

  // Exports alone, Germany highlighted: the one line shown is faint and still.
  const controls = layer.getRowControls();
  controls.segmented.options.find((o) => o.id === 'show-export').onClick();
  controls.chips.find((chip) => chip.id === 'country-DE').onClick();
  assert.ok(framesIn(1980) > 0, 'while the new line builds');
  framesIn(200);
  assert.equal(framesIn(5000), 0, 'then nothing moves');
});

test('reduced motion stills the chevrons, and no tick asks for it', async (t) => {
  mockClock(t);
  const query = {
    matches: true,
    listener: null,
    addEventListener: (type, listener) => (query.listener = listener),
    removeEventListener: () => (query.listener = null),
  };
  let asked = 0;
  globalThis.matchMedia = () => {
    asked += 1;
    return query;
  };
  t.after(() => delete globalThis.matchMedia);
  const { layer, viewer, state } = harness(
    t,
    { getSnapshot: async () => snapshot() },
    { camera: fakeCamera() },
  );
  const framesIn = (ms) => {
    state.frames = 0;
    t.mock.timers.tick(ms);
    return state.frames;
  };
  layer.enable();
  await layer.update();
  framesIn(3000);
  asked = 0;
  assert.equal(framesIn(5000), 0, 'still');
  assert.equal(asked, 0, 'the tick does not ask');

  // The reader allows motion: the lines are drawn again, moving.
  const adds = viewer.adds;
  query.matches = false;
  query.listener();
  assert.ok(viewer.adds > adds);
  framesIn(3000);
  assert.equal(framesIn(660), 10);

  layer.disable();
  assert.equal(query.listener, null, 'released');
});

test('an identical answer draws nothing again and leaves the day alone', async (t) => {
  let answer = snapshot();
  let dayLoads = 0;
  let rowCalls = 0;
  const { layer, viewer, state, entities } = harness(t, {
    // Each answer is a new object read at a new time.
    getSnapshot: async () => ({
      ...structuredClone(answer),
      fetchedAt: Date.now(),
    }),
    getDay: async () => {
      dayLoads += 1;
      return { date: '2026-11-10', points: [], stale: false };
    },
  });
  layer.attachDayPanel({ publish() {}, connect: () => () => {} });
  layer.setRowControlsListener(() => (rowCalls += 1));
  layer.enable();
  await layer.update();
  assert.equal(entities().filter((entity) => entity.polyline).length, 3);
  const counts = () => ({
    adds: viewer.adds,
    labels: state.labelPublishes,
    days: dayLoads,
  });
  const first = counts();
  const firstEntities = [...entities()];
  assert.ok(first.adds > 0 && first.labels > 0 && first.days > 0);

  await layer.update();
  assert.deepEqual(counts(), first);
  assert.deepEqual([...entities()], firstEntities, 'the same entities');
  assert.equal(rowCalls, 2, 'the row still hears of the answer');
  assert.equal(layer.getStats().error, null);

  // Another flow at the same quarter-hour: drawn again, the day is not read.
  answer = snapshot({ links: withMw('FI_SE3', 412) });
  await layer.update();
  const second = counts();
  assert.ok(second.adds > first.adds);
  assert.ok(second.labels > first.labels);
  assert.equal(second.days, first.days);
  assert.ok(
    state.labels.some((entry) => entry.title.includes('412')),
    'the new value is on the map',
  );

  // A new quarter-hour: the day has grown.
  answer = snapshot({
    links: withMw('FI_SE3', 412),
    updated: UPDATED + QUARTER_MS,
    production: { ...snapshot().production, at: UPDATED + QUARTER_MS },
  });
  await layer.update();
  assert.ok(counts().adds > second.adds);
  assert.equal(counts().days, second.days + 1);

  // Only stale now: the row must say so, and it is drawn once.
  answer = { ...answer, stale: true };
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  const stale = counts();
  await layer.update();
  assert.deepEqual(counts(), stale);
});

test('a day that failed or came back old is asked for at the next poll', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // Turning on and the first answer each load the day: both fail.
  const answers = [
    new Error('HTTP 502'),
    new Error('HTTP 502'),
    { date: '2026-11-10', points: [], stale: true },
    { date: '2026-11-10', points: [], stale: false },
  ];
  let dayLoads = 0;
  const { layer } = harness(t, {
    getSnapshot: async () => snapshot(),
    getDay: async () => {
      const answer = answers[Math.min(dayLoads, answers.length - 1)];
      dayLoads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  layer.attachDayPanel({ publish() {}, connect: () => () => {} });
  layer.enable();
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  const failed = dayLoads;
  assert.equal(failed, 2);

  // The same quarter-hour, yet the failed day is read again: it is old.
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dayLoads, failed + 1);

  // Old, so once more; this one is fresh and the day is left alone after.
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dayLoads, failed + 2);
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dayLoads, failed + 2);
});

test('a paused layer draws its next answer again', async (t) => {
  const { layer, viewer, state } = harness(t, {
    getSnapshot: async () => snapshot(),
  });
  layer.enable();
  await layer.update();
  layer.disable();
  assert.equal(state.labels.length, 0);
  const adds = viewer.adds;
  layer.enable();
  await layer.update();
  assert.ok(viewer.adds > adds);
  assert.deepEqual(flowLabels(state), ['DE_SE4', 'FI_SE3', 'SE2_SE3']);
});

test('a highlighted country that leaves the answer is let go', async (t) => {
  let answer = snapshot();
  const { layer, state } = harness(t, { getSnapshot: async () => answer });
  const highlight = (id) =>
    layer
      .getRowControls()
      .chips.find((chip) => chip.id === id)
      .onClick();
  layer.enable();
  await layer.update();
  highlight('country-FI');
  assert.deepEqual(flowLabels(state), ['FI_SE3']);

  // Finland is still there: it stays highlighted.
  answer = snapshot({ links: withMw('SE2_SE3', 5100) });
  await layer.update();
  assert.equal(activeChip(layer), 'country-FI');
  assert.deepEqual(flowLabels(state), ['FI_SE3']);

  highlight('country-FI');
  highlight('country-DE');
  assert.equal(activeChip(layer), 'country-DE');
  answer = snapshot({ links: LINKS.filter((link) => link.id !== 'DE_SE4') });
  await layer.update();
  assert.equal(activeChip(layer), undefined);
  assert.deepEqual(flowLabels(state), ['FI_SE3', 'SE2_SE3'], 'nothing dimmed');
});

test('a change of language words the open card again', async (t) => {
  t.after(() => setLocale('en'));
  const { layer, viewer, state, dot } = harness(t, {
    getSnapshot: async () => snapshot(),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: dot('SE3').id };
  state.click(CLICK);
  assert.equal(state.cards[0].title, 'POWER GRID · SE3 STOCKHOLM');

  const publishes = state.cardPublishes;
  setLocale('sv');
  assert.equal(state.cardPublishes, publishes + 1);
  assert.equal(state.cards[0].title, 'KRAFTSYSTEMET · SE3 STOCKHOLM');

  // No card open: none appears.
  viewer.picked = undefined;
  state.click(CLICK);
  setLocale('en');
  assert.equal(state.cards.length, 0);
});

test('the dots move when the ground heights arrive', async (t) => {
  clearGroundHeightStore();
  t.after(clearGroundHeightStore);
  const { layer, viewer, state, entities, dot } = harness(
    t,
    { getSnapshot: async () => snapshot() },
    {
      terrain: {
        resolveEllipsoidalGround: async (points) =>
          points.map(() => ({ ellipsoid: 250, source: 'reearth' })),
      },
    },
  );
  const heightOf = (entity) =>
    Cesium.Cartographic.fromCartesian(
      entity.position.getValue(Cesium.JulianDate.now()),
    ).height;
  const changes = [];
  layer.enable();
  viewer.sources[0].entities.collectionChanged.addEventListener(
    (collection, added, removed) =>
      changes.push({
        added: added.map((entity) => entity.id),
        removed: removed.map((entity) => entity.id),
      }),
  );
  await layer.update();
  const before = dot('SE3');
  const beforeEnd = entities().find((entity) =>
    entity.id.startsWith('power-grid-end:FI_SE3:'),
  );
  // The heights answer after the first drawing.
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));

  const after = dot('SE3');
  assert.notEqual(after.id, before.id);
  assert.ok(Math.abs(heightOf(after) - 250) < 1, 'the zone dot is up');
  const afterEnd = entities().find((entity) =>
    entity.id.startsWith('power-grid-end:FI_SE3:'),
  );
  assert.ok(Math.abs(heightOf(afterEnd) - 250) < 1, 'and the far end');
  // Cesium is told: the old dots went, the new ones came.
  const last = changes.at(-1);
  assert.ok(last.removed.includes(before.id));
  assert.ok(last.removed.includes(beforeEnd.id));
  assert.ok(last.added.includes(after.id));
  assert.ok(last.added.includes(afterEnd.id));

  // The new dot is still the zone.
  viewer.picked = { id: after.id };
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'power-grid-card:SE3');
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { layer, viewer, state } = harness(t, {
    getSnapshot: async () => snapshot(),
  });
  layer.enable();
  t.mock.method(
    viewer.sources[0].entities,
    'add',
    () => {
      throw new Error('no room');
    },
    { times: 1 },
  );
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:PowerGrid] Draw error:',
  );
  // The same answer five minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(flowLabels(state), ['DE_SE4', 'FI_SE3', 'SE2_SE3']);
});

test('turning the layer off clears its error', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { layer } = harness(t, {
    getSnapshot: async () => {
      throw new Error('down');
    },
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().error, 'down');
  layer.disable();
  assert.equal(layer.getStats().error, null);
});
