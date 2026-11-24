// Swedish fork: Trafiklab vehicles follow their trip's route shape between
// two position reports (routeShapes.js), through the layer's own trails.js
// and movement.js, over a stub surface and a scripted shapes route.
import test from 'node:test';
import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';
import { createTrails } from './trails.js';
import { createRouteShapes } from './routeShapes.js';
import { createTransitCockpitSubject } from './cockpitSubject.js';
import { createState } from './state.js';
import { createSelection } from './selection.js';
import { createLifecycle } from './lifecycle.js';
import { initializePlayback, recordFix, updatePlayback } from './movement.js';
import { seek, setRate } from '../../data/contactPlayback.js';
import { encodeRouteShape } from '../../data/transitRouteShapes.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

const M_PER_DEG = 111_320;
const metres = (a, b) =>
  Math.hypot(
    (b.lat - a.lat) * M_PER_DEG,
    (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180),
  );

// A street north 1.1 km, then east: the corner is at 59.31, 18.00.
const CORNER = { lat: 59.31, lon: 18.0 };
const L_STREET = encodeRouteShape([59.3, 18.0, 59.31, 18.0, 59.31, 18.02]);
const T0 = 1_000_000;
/** A bus up the street, round the corner, and on east. */
const FIXES = [
  { t: T0, lat: 59.3, lon: 18.0001 },
  { t: T0 + 60_000, lat: 59.305, lon: 18.0001 },
  { t: T0 + 160_000, lat: 59.3101, lon: 18.01 },
  { t: T0 + 220_000, lat: 59.3101, lon: 18.015 },
];

/** Let the batched request and its answer run. */
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
}

/** A scripted `/api/transit/shapes`: `shapes` by id, the rest missing. */
function shapesRoute(shapes, { staticAt = 1 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const asked = new URL(url, 'http://localhost');
    const ids = asked.searchParams.get('ids').split(',');
    requests.push({
      path: asked.pathname,
      feed: asked.searchParams.get('feed'),
      ids,
      signal: init?.signal,
    });
    const body = {
      version: 1,
      feedId: asked.searchParams.get('feed'),
      staticAt,
      shapes: Object.fromEntries(
        ids.filter((id) => shapes[id]).map((id) => [id, shapes[id]]),
      ),
      missing: ids.filter((id) => !shapes[id]),
      deferred: [],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { requests, fetchImpl };
}

/** The layer state, services and parts trails.js reads, on a flat floor. */
function layer({ enabled = true, cameraHeightM = 800 } = {}) {
  const state = {
    _enabled: enabled,
    _visible: new Set(),
    _vehicles: new Map(),
    _selectedKey: null,
    _cockpitSubjectKey: null,
    _heightDirty: new Set(),
    _viewer: null,
    _activeFeeds: new Map(),
    _feedStatus: new Map(),
  };
  const renders = [];
  const services = {
    render: { governorRequestRender: (reason) => renders.push(reason) },
  };
  const camera = { heightM: cameraHeightM };
  const parts = {
    height: {
      requestHeight: (lat, lon) => ({
        cell: `${lat.toFixed(3)},${lon.toFixed(3)}`,
        height: 20,
        prior: null,
      }),
      nearGround: () => true,
    },
    rendering: { cameraHeightM: () => camera.heightM, sampleIdle() {} },
  };
  parts.trails = createTrails({ state, services, parts, source: null });
  return { state, services, parts, trails: parts.trails, renders, camera };
}

/** A Trafiklab vehicle on trip `trip`, whose newest report names `shapeId`. */
function vehicle(
  ctx,
  {
    key = 'trafiklab-sl:v1',
    feedId = 'trafiklab-sl',
    trip = 'T1',
    shapeId = 'S1',
    fixes = FIXES,
    visible = true,
  } = {},
) {
  const entry = {
    key,
    feedId,
    mode: 'bus',
    modeInferred: false,
    courseDeg: null,
    record: { id: key.split(':')[1], tripId: trip, shapeId, routeId: 'bus:4' },
  };
  initializePlayback(entry);
  for (const fix of fixes)
    recordFix(entry, fix, {
      receivedAt: fix.t + 1000,
      wallNowMs: fix.t + 1000,
      monoNowMs: 0,
      context: { trip, route: 'bus:4', mode: 'bus' },
    });
  ctx.state._vehicles.set(key, entry);
  if (visible) ctx.state._visible.add(entry);
  return entry;
}

/** Hold the vehicle's playback at report time `displayT`. */
function showAt(entry, displayT) {
  entry.clocks.wallNowMs = displayT + 30_000;
  entry.clocks.monoNowMs = 0;
  seek(entry.track, displayT, entry.clocks);
  updatePlayback(entry, displayT + 30_000, 0);
}

/** The display path from report `i` of `entry`'s fixes. */
const pathFrom = (entry, i) => entry.displayPaths.get(entry.track.baseSeq + i);

function snapshotOf(ctx, entry) {
  return createTransitCockpitSubject({
    state: ctx.state,
    parts: ctx.parts,
    services: ctx.services,
  }).vehicleView(entry);
}

test('a bus on an L-shaped street turns the corner its route takes', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  // Asked for after the pass; straight steps meanwhile.
  assert.equal(pathFrom(entry, 1).shape, undefined);
  assert.equal(route.requests.length, 0, 'batched after the pass');
  await settle();
  assert.equal(route.requests.length, 1);
  assert.deepEqual(route.requests[0], {
    path: '/api/transit/shapes',
    feed: 'trafiklab-sl',
    ids: ['S1'],
    signal: route.requests[0].signal,
  });
  assert.ok(ctx.renders.includes('transit-route-shapes'));
  // The shape came, and the vehicle's paths were prepared again.
  const path = pathFrom(entry, 1);
  const along = path.shape;
  assert.ok(along, 'round the corner along the street');
  assert.equal(path.positions.length, along.lat.length);
  const nearest = along.lat.reduce(
    (best, lat, k) => {
      const d = metres(CORNER, { lat, lon: along.lon[k] });
      return d < best.d ? { d, k } : best;
    },
    { d: Infinity, k: -1 },
  );
  assert.ok(nearest.d < 12, `${nearest.d} m from the corner`);

  // Played to the corner, the bus is at it, drawn where its sample says.
  const [a, b] = [FIXES[1], FIXES[2]];
  showAt(entry, a.t + (b.t - a.t) * along.fractions[nearest.k]);
  assert.ok(metres(CORNER, entry.sample) < 12);
  assert.equal(entry.routeShapeDrawn, true);
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(ctx.trails.samplePosition(entry, entry.sample, out, true), out);
  const at = fromDegrees(entry.sample.lon, entry.sample.lat, 20);
  assert.ok(Math.hypot(out.x - at.x, out.y - at.y, out.z - at.z) < 0.1);
  // North before the corner and east after it; at the way's own speed.
  showAt(entry, a.t + (b.t - a.t) * 0.2);
  const north = entry.sample.segmentCourseDeg;
  assert.ok(north < 3 || north > 357, `${north}`);
  showAt(entry, a.t + (b.t - a.t) * 0.8);
  assert.ok(Math.abs(entry.sample.segmentCourseDeg - 90) < 3);
  assert.ok(
    Math.abs(entry.sample.segmentSpeedMps - (along.sB - along.sA) / 100) < 1e-9,
  );
  // A straight line would have cut the corner by hundreds of metres.
  const chord = {
    lat: a.lat + (b.lat - a.lat) * along.fractions[nearest.k],
    lon: a.lon + (b.lon - a.lon) * along.fractions[nearest.k],
  };
  assert.ok(metres(CORNER, chord) > 200);
  // The driver's view is told.
  assert.equal(snapshotOf(ctx, entry).motion.alongRouteShape, true);
  entry.placed = true;
  assert.equal(snapshotOf(ctx, entry).motion.alongRouteShape, false);
});

test('a report off the shape gives straight lines, and says so', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  // 100 m north of the eastbound street: a detour.
  const entry = vehicle(ctx, {
    fixes: [FIXES[1], { t: FIXES[2].t, lat: 59.311, lon: 18.01 }],
  });
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(route.requests.length, 1, 'its shape was asked for');
  assert.equal(pathFrom(entry, 0).shape, undefined);
  assert.equal(pathFrom(entry, 0).positions.length > 2, true, 'straight steps');
  assert.equal(entry.routeShaped, false);
  showAt(entry, FIXES[1].t + 50_000);
  assert.equal(snapshotOf(ctx, entry).motion.alongRouteShape, false);
});

test('a way back along the shape gives straight lines', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const entry = vehicle(ctx, {
    fixes: [
      { ...FIXES[2], t: T0 },
      { ...FIXES[1], t: T0 + 100_000 },
    ],
  });
  showAt(entry, T0);
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(route.requests.length, 1);
  assert.equal(pathFrom(entry, 0).shape, undefined);
});

test('a missing shape gives straight lines and is not asked for again at once', async (t) => {
  const route = shapesRoute({});
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  await settle();
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(route.requests.length, 1);
  assert.equal(pathFrom(entry, 1).shape, undefined);
  // A vehicle with no shape named, or of a feed without shapes, asks nothing.
  vehicle(ctx, { key: 'trafiklab-sl:v2', shapeId: null });
  vehicle(ctx, { key: 'mbta:v3', feedId: 'mbta' });
  for (const key of ['trafiklab-sl:v2', 'mbta:v3']) {
    const other = ctx.state._vehicles.get(key);
    showAt(other, FIXES[1].t);
    ctx.trails.prepareEntry(other);
    assert.equal(pathFrom(other, 1).shape, undefined);
  }
  await settle();
  assert.equal(route.requests.length, 1);
});

test('the segment a vehicle is drawn along keeps its line; the next follows the shape', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const entry = vehicle(ctx);
  // Mid-way round the corner when the shape is asked for.
  showAt(entry, FIXES[1].t + 50_000);
  ctx.trails.prepareEntry(entry);
  const straight = pathFrom(entry, 1);
  await settle();
  // No sideways jump: the segment being drawn stays as it was drawn.
  assert.equal(pathFrom(entry, 1).shape, undefined);
  assert.deepEqual(pathFrom(entry, 1).positions, straight.positions);
  assert.ok(pathFrom(entry, 2).shape, 'the segment after it follows the shape');
  // Drawn in a straight line, it stays so, even when the vehicle is not
  // on it: a trail shows the way it was drawn.
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  assert.equal(pathFrom(entry, 1).shape, undefined);
});

test('the selected vehicle’s trail is not redrawn along a shape that came late', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  let release = null;
  // The shape's answer is held until the vehicle has gone past.
  t.mock.method(
    globalThis,
    'fetch',
    (url, init) =>
      new Promise((resolve) => {
        release = () => resolve(route.fetchImpl(url, init));
      }),
  );
  const ctx = layer();
  const entry = vehicle(ctx);
  ctx.state._selectedKey = entry.key;
  showAt(entry, FIXES[1].t + 50_000);
  ctx.trails.select(entry);
  t.after(() => ctx.trails.clear());
  // On round the corner and into the next segment, still without it.
  showAt(entry, FIXES[2].t + 10_000);
  ctx.trails.prepareEntry(entry);
  await settle();
  release();
  await settle();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 1, 'it came');
  // The corner it went round in a straight line stays straight.
  assert.equal(pathFrom(entry, 1).shape, undefined);
  const corner = entry.trailSegments.filter(
    (segment) => segment.fromSeq === entry.track.baseSeq + 1,
  );
  assert.ok(corner.length > 1);
  // Even straight steps between the two reports; the shape's are not even.
  const step = corner[0].toT - corner[0].fromT;
  for (const segment of corner)
    assert.ok(Math.abs(segment.toT - segment.fromT - step) < 1e-6);
});

test('vehicles asking in one pass share one request; only drawn, moving ones ask', async (t) => {
  const route = shapesRoute({ S1: L_STREET, S2: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const one = vehicle(ctx);
  const two = vehicle(ctx, {
    key: 'trafiklab-sl:v2',
    trip: 'T2',
    shapeId: 'S2',
  });
  const hidden = vehicle(ctx, {
    key: 'trafiklab-sl:v3',
    trip: 'T3',
    shapeId: 'S3',
    visible: false,
  });
  const standing = vehicle(ctx, {
    key: 'trafiklab-sl:v4',
    trip: 'T4',
    shapeId: 'S4',
    fixes: [FIXES[0], { ...FIXES[0], t: FIXES[1].t, lat: 59.300001 }],
  });
  for (const entry of [one, two, hidden, standing]) {
    showAt(entry, FIXES[0].t);
    ctx.trails.prepareEntry(entry);
  }
  await settle();
  assert.equal(route.requests.length, 1);
  assert.deepEqual(route.requests[0].ids, ['S1', 'S2']);
  assert.ok(pathFrom(one, 1).shape && pathFrom(two, 1).shape);
});

test('the least recently used shape goes first, never one still in use', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const route = shapesRoute({ S1: L_STREET, S2: L_STREET, S3: L_STREET });
  const ctx = layer();
  const prepared = [];
  const shapes = createRouteShapes({
    state: ctx.state,
    parts: ctx.parts,
    services: ctx.services,
    prepare: (entry) => prepared.push(entry.key),
    fetchImpl: route.fetchImpl,
    maxShapes: 2,
  });
  const ask = (entry) => {
    const pass = shapes.begin(entry);
    const [a, b] = [entry.fixes[1], entry.fixes[2]];
    const geom = shapes.segment(pass, a, b, 600);
    shapes.end(entry, pass);
    return geom;
  };
  const cars = ['S1', 'S2', 'S3'].map((shapeId, i) => {
    const entry = vehicle(ctx, {
      key: `trafiklab-sl:v${i}`,
      trip: `T${i}`,
      shapeId,
    });
    showAt(entry, FIXES[1].t);
    return entry;
  });
  ask(cars[0]);
  await settle();
  t.mock.timers.tick(31_000);
  ask(cars[1]);
  await settle();
  assert.equal(shapes.diagnostics().shapes, 2);
  // Both used within the last half minute: the third waits.
  ask(cars[0]);
  ask(cars[1]);
  ask(cars[2]);
  await settle();
  assert.equal(route.requests.length, 2);
  assert.equal(shapes.diagnostics().shapes, 2);
  // Half a minute on, the least recently used gives way.
  t.mock.timers.tick(31_000);
  ask(cars[1]);
  ask(cars[2]);
  await settle();
  assert.equal(route.requests.length, 3);
  assert.equal(shapes.diagnostics().shapes, 2);
  assert.ok(ask(cars[1]) && ask(cars[2]));
  // A segment decided keeps its points; a new one finds S1 gone.
  assert.ok(ask(cars[0]), 'decided before');
  const late = vehicle(ctx, { key: 'trafiklab-sl:v9', trip: 'T9' });
  showAt(late, FIXES[1].t);
  assert.equal(ask(late), null, 'S1 was evicted');
  t.mock.timers.tick(31_000);
  await settle();
  assert.deepEqual(route.requests.at(-1).ids, ['S1'], 'and is asked again');
  // Each vehicle that asked is prepared again once its shape is here.
  assert.deepEqual(prepared, [
    'trafiklab-sl:v0',
    'trafiklab-sl:v1',
    'trafiklab-sl:v2',
    'trafiklab-sl:v0',
    'trafiklab-sl:v9',
  ]);

  // The points are capped too: two three-point shapes over five points.
  const few = createRouteShapes({
    state: ctx.state,
    parts: ctx.parts,
    services: ctx.services,
    prepare() {},
    fetchImpl: route.fetchImpl,
    maxPoints: 5,
  });
  for (const car of cars.slice(0, 2)) {
    few.segment(few.begin(car), car.fixes[1], car.fixes[2], 600);
    await settle();
    t.mock.timers.tick(31_000);
  }
  assert.deepEqual(
    [few.diagnostics().shapes, few.diagnostics().points],
    [1, 3],
  );
});

test('nothing is asked for while the layer is off, and turning it off drops everything', async (t) => {
  let answer = null;
  const asked = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    asked.push({ url, signal: init.signal });
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const ctx = layer({ enabled: false });
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(asked.length, 0, 'off: nothing asked');

  ctx.state._enabled = true;
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(ctx.trails.routeShapeDiagnostics().inFlight, 1);
  // Off, as lifecycle.js's disable does: the flag, then the selection cleared.
  ctx.state._enabled = false;
  ctx.trails.clear();
  assert.equal(asked[0].signal.aborted, true);
  assert.deepEqual(ctx.trails.routeShapeDiagnostics(), {
    shapes: 0,
    points: 0,
    requests: 1,
    pending: 0,
    inFlight: 0,
    waiting: 0,
  });
  // A late answer is thrown away.
  const body = {
    version: 1,
    feedId: 'trafiklab-sl',
    staticAt: 1,
    shapes: { S1: L_STREET },
    missing: [],
    deferred: [],
  };
  answer({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  await settle();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 0);
  assert.equal(asked.length, 1);
  // On again, it is asked again; clearing a selection then keeps the shapes.
  ctx.state._enabled = true;
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(asked.length, 2);
  answer({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  await settle();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 1);
  ctx.trails.clear();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 1);
});

test('turning the layer off through its lifecycle aborts and drops the shapes', async (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  });
  t.after(() => {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  });
  let signal = null;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    render: { governorRequestRender() {}, releaseContinuousRender() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  };
  const state = createState({ services });
  // The layer's own state, trails, selection and lifecycle; only the parts
  // that draw, poll and read the ground are stood in for.
  const parts = {
    height: {
      requestHeight: () => ({ cell: 'c', height: 20, prior: null }),
      nearGround: () => true,
      clear() {},
    },
    rendering: {
      cameraHeightM: () => 800,
      cancelWake() {},
      clearMarkers() {},
      paintSelected() {},
      stopFrames() {},
      stopModels() {},
      unwatchCamera() {},
    },
    ingestion: { abortAllInFlight() {} },
    testing: { _stopTransitProbeForTest() {} },
  };
  const context = { state, services, parts, source: null };
  parts.trails = createTrails(context);
  parts.selection = createSelection(context);
  const lifecycle = createLifecycle(context).methods;
  state._enabled = true;
  const entry = vehicle({ state });
  showAt(entry, FIXES[1].t);
  parts.trails.prepareEntry(entry);
  await settle();
  assert.equal(signal?.aborted, false, 'asked while on');
  lifecycle.disable(null);
  assert.equal(signal.aborted, true);
  assert.equal(parts.trails.routeShapeDiagnostics().inFlight, 0);
  assert.equal(parts.trails.routeShapeDiagnostics().waiting, 0);
});

test('above the height where a corner shows, nothing is asked', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer({ cameraHeightM: 20_000 });
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(route.requests.length, 0);
  ctx.camera.heightM = 2_000;
  ctx.trails.prepareEntry(entry);
  await settle();
  assert.equal(route.requests.length, 1);
  assert.ok(pathFrom(entry, 1).shape);
});

test('new static GTFS drops the feed’s older shapes', async (t) => {
  let staticAt = 1;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const ids = new URL(url, 'http://localhost').searchParams
      .get('ids')
      .split(',');
    requests.push(ids);
    const body = {
      version: 1,
      feedId: 'trafiklab-sl',
      staticAt,
      shapes: Object.fromEntries(ids.map((id) => [id, L_STREET])),
      missing: [],
      deferred: [],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  const ctx = layer();
  const one = vehicle(ctx);
  const two = vehicle(ctx, {
    key: 'trafiklab-sl:v2',
    trip: 'T2',
    shapeId: 'S2',
  });
  for (const entry of [one]) {
    showAt(entry, FIXES[1].t);
    ctx.trails.prepareEntry(entry);
  }
  await settle();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 1);
  staticAt = 2;
  showAt(two, FIXES[1].t);
  ctx.trails.prepareEntry(two);
  await settle();
  assert.equal(ctx.trails.routeShapeDiagnostics().shapes, 1, 'S1 dropped');
  assert.deepEqual(requests, [['S1'], ['S2']]);
});

/** One shape for the vehicle `entry`, asked for and here. */
async function shapedVehicle(t, shapes, fixes, at) {
  const route = shapesRoute(shapes);
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const entry = vehicle(ctx, { fixes });
  showAt(entry, at);
  ctx.trails.prepareEntry(entry);
  await settle();
  return { ctx, entry, route };
}

test('standing at a stop it reached along its shape, a bus faces the way it came, and says so', async (t) => {
  // Up the street, round the corner, then at a stop: two reports at one
  // place 30 s apart, the newest of them held.
  const fixes = [
    { t: T0, lat: 59.3, lon: 18.0001 },
    { t: T0 + 30_000, lat: 59.3055, lon: 18.0001 },
    { t: T0 + 90_000, lat: 59.31005, lon: 18.0021 },
    { t: T0 + 120_000, lat: 59.31005, lon: 18.0021 },
  ];
  const { ctx, entry } = await shapedVehicle(
    t,
    { S1: L_STREET },
    fixes,
    fixes[0].t + 1000,
  );
  assert.ok(pathFrom(entry, 1).shape, 'round the corner along the shape');
  showAt(entry, fixes[1].t + 0.9 * (fixes[2].t - fixes[1].t));
  assert.equal(entry.sample.segmentCourseDeg, 90, 'east, along the street');
  for (const at of [fixes[2].t + 10_000, fixes[3].t + 5_000]) {
    // A preparation while it stands, as each poll makes, changes nothing.
    showAt(entry, at);
    ctx.trails.prepareEntry(entry);
    showAt(entry, at);
    assert.equal(entry.sample.segmentCourseDeg, 90, `${at}`);
    assert.equal(snapshotOf(ctx, entry).motion.alongRouteShape, true, `${at}`);
  }
});

test('a few metres of jitter or creep along the shape give no course of their own', async (t) => {
  // North 150 m, then at a stop 0.6 m on and 3 m east, then 5 m on and 4 m
  // west: the street runs north all the way.
  const north = (m) => m / 111_320;
  const east = (m) => m / (111_320 * Math.cos((59.3 * Math.PI) / 180));
  const fixes = [
    { t: T0, lat: 59.301, lon: 18.0 },
    { t: T0 + 15_000, lat: 59.301 + north(150), lon: 18.0 },
    { t: T0 + 20_000, lat: 59.301 + north(150.6), lon: 18.0 + east(3) },
    { t: T0 + 25_000, lat: 59.301 + north(155.6), lon: 18.0 - east(1) },
  ];
  const { entry } = await shapedVehicle(
    t,
    { S1: encodeRouteShape([59.3, 18.0, 59.32, 18.0]) },
    fixes,
    T0 - 5_000,
  );
  for (let i = 0; i < 3; i++) {
    showAt(entry, (fixes[i].t + fixes[i + 1].t) / 2);
    const course = entry.sample.segmentCourseDeg;
    assert.ok(course < 1 || course > 359, `segment ${i}: ${course}`);
  }
});

/** North on the west lane, round a block, back south on the east lane. */
const lollipop = (back) =>
  encodeRouteShape([
    59.3,
    18.0,
    59.309,
    18.0,
    59.3097,
    18.0,
    59.3097,
    18.0008,
    59.309,
    18.0008,
    59.309,
    back,
    59.3,
    back,
  ]);

test('a bus out of the loop that stops, then drives on, does not drive the loop again', async (t) => {
  const stop = { lat: 59.3089, lon: 18.00001 };
  const fixes = [
    { t: T0, lat: 59.30902, lon: 18.0005 },
    { t: T0 + 15_000, ...stop },
    { t: T0 + 35_000, ...stop },
    { t: T0 + 55_000, lat: 59.307, lon: 18.00004 },
  ];
  const { entry } = await shapedVehicle(
    t,
    { S1: lollipop(18.00004) },
    fixes,
    T0 - 5_000,
  );
  const on = pathFrom(entry, 2).shape;
  assert.ok(on, 'on along the way back');
  assert.ok(on.sB - on.sA < 230, `${on.sB - on.sA} m along`);
  assert.ok(Math.max(...on.lat) < 59.30902, 'not round the block');
});

test('where a standing bus is along its shape carries over its stop, from one poll to the next', async (t) => {
  // The way back runs 28 m east of the way out. The bus stops just out of
  // the loop with its reports 23 m west of its lane, 6 m from the way out:
  // only where it came from tells the two apart.
  const back = 18.0005;
  const stop = { lat: 59.3088, lon: 18.0001 };
  const fixes = [
    { t: T0, lat: 59.30902, lon: 18.0007 },
    { t: T0 + 15_000, ...stop },
    { t: T0 + 35_000, ...stop },
  ];
  const { ctx, entry } = await shapedVehicle(
    t,
    { S1: lollipop(back) },
    fixes,
    T0 - 5_000,
  );
  assert.ok(pathFrom(entry, 0).shape, 'out of the loop to the stop');
  // The next report comes while the bus is drawn at the stop.
  recordFix(
    entry,
    { t: T0 + 55_000, lat: 59.307, lon: back },
    {
      receivedAt: T0 + 56_000,
      wallNowMs: T0 + 56_000,
      monoNowMs: 0,
      context: { trip: 'T1', route: 'bus:4', mode: 'bus' },
    },
  );
  showAt(entry, T0 + 25_000);
  ctx.trails.prepareEntry(entry);
  const on = pathFrom(entry, 2).shape;
  assert.ok(on, 'on along the way back');
  assert.ok(on.sB - on.sA < 230, `${on.sB - on.sA} m along`);
  assert.ok(Math.max(...on.lat) < 59.3089, 'not round the block');
});

test('a batch of new shapes never evicts shapes still in use', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const ids = ['S1', 'S2', 'S3', 'S4', 'S5'];
  const route = shapesRoute(
    Object.fromEntries(ids.map((id) => [id, L_STREET])),
  );
  const ctx = layer();
  const shapes = createRouteShapes({
    state: ctx.state,
    parts: ctx.parts,
    services: ctx.services,
    prepare() {},
    fetchImpl: route.fetchImpl,
    maxShapes: 3,
  });
  const ask = (entry) => {
    const pass = shapes.begin(entry);
    const geom = shapes.segment(pass, entry.fixes[1], entry.fixes[2], 600);
    shapes.end(entry, pass);
    return geom;
  };
  const cars = ids.map((shapeId, i) => {
    const entry = vehicle(ctx, {
      key: `trafiklab-sl:v${i}`,
      trip: `T${i}`,
      shapeId,
    });
    showAt(entry, FIXES[1].t);
    return entry;
  });
  ask(cars[0]);
  ask(cars[1]);
  await settle();
  t.mock.timers.tick(1_000);
  // S1 and S2 in use; three more asked for in one pass, room for one.
  for (const car of cars) ask(car);
  await settle();
  assert.deepEqual(
    route.requests.map((request) => request.ids),
    [['S1', 'S2'], ['S3']],
  );
  for (const [i, shapeId] of [
    [0, 'S1'],
    [1, 'S2'],
  ]) {
    const late = vehicle(ctx, {
      key: `trafiklab-sl:late${i}`,
      trip: `T${i}`,
      shapeId,
    });
    showAt(late, FIXES[1].t);
    assert.ok(ask(late), `${shapeId} still kept`);
  }
});

test('vehicles past a full queue are not held on to', async (t) => {
  // 300 vehicles on 300 shapes in one pass; the queue holds 256.
  const shapes = {};
  for (let i = 0; i < 300; i++) shapes[`S${i}`] = L_STREET;
  const route = shapesRoute(shapes);
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const ctx = layer();
  const cars = [];
  for (let i = 0; i < 300; i++) {
    const entry = vehicle(ctx, {
      key: `trafiklab-sl:v${i}`,
      trip: `T${i}`,
      shapeId: `S${i}`,
    });
    showAt(entry, FIXES[0].t + 1000);
    cars.push(entry);
  }
  for (const entry of cars) ctx.trails.prepareEntry(entry);
  assert.equal(ctx.trails.routeShapeDiagnostics().waiting, 256);
  // Those past the queue leave the layer before another pass.
  for (const entry of cars.slice(256)) {
    ctx.state._vehicles.delete(entry.key);
    ctx.state._visible.delete(entry);
  }
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(route.requests.length, 8);
  assert.equal(ctx.trails.routeShapeDiagnostics().waiting, 0);
});

test('above 15 km nothing is even queued', () => {
  const ctx = layer({ cameraHeightM: 20_000 });
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  ctx.trails.prepareEntry(entry);
  assert.equal(ctx.trails.routeShapeDiagnostics().waiting, 0);
});

test('a refused shapes answer has its body let go', async () => {
  let cancelled = false;
  const ctx = layer();
  const shapes = createRouteShapes({
    state: ctx.state,
    parts: ctx.parts,
    services: ctx.services,
    prepare() {},
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    }),
  });
  const entry = vehicle(ctx);
  showAt(entry, FIXES[1].t);
  shapes.segment(shapes.begin(entry), entry.fixes[1], entry.fixes[2], 600);
  await settle();
  assert.equal(cancelled, true);
  assert.equal(shapes.diagnostics().inFlight, 0);
});

test('a shaped frame looks its path up once, as a straight one does', async (t) => {
  const { ctx, entry } = await shapedVehicle(
    t,
    { S1: L_STREET },
    FIXES,
    FIXES[1].t,
  );
  assert.ok(pathFrom(entry, 1).shape);
  const paths = entry.displayPaths;
  const get = paths.get;
  let gets = 0;
  paths.get = function (key) {
    gets += 1;
    return get.call(this, key);
  };
  const out = { x: 0, y: 0, z: 0 };
  for (let f = 0.1; f < 0.95; f += 0.1) {
    showAt(entry, FIXES[1].t + (FIXES[2].t - FIXES[1].t) * f);
    ctx.trails.samplePosition(entry, entry.sample, out, true);
  }
  // samplePosition's own lookup each frame, and the hook's once.
  assert.equal(gets, 9 + 1);
});

/** Source files whose allocations are the layer's own, as its fleet QA reads them. */
const LAYER_SOURCE =
  /\/layers\/transit\/|\/data\/(?:contactPlayback|contactTrailRenderer|transit[^/]*)\.js/;

/** Bytes per frame the layer's own code allocates while `frame()` runs. */
async function layerFrameBytes(frame, frames) {
  const session = new inspector.Session();
  session.connect();
  try {
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 32,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < frames; i++) frame();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let bytes = 0;
    const sites = new Map();
    const own = (url) => LAYER_SOURCE.test(url) && !url.includes('.test.');
    (function visit(node, parentUrl) {
      const { url, functionName, lineNumber } = node.callFrame;
      if ((own(url) || (!url && own(parentUrl))) && node.selfSize) {
        bytes += node.selfSize;
        const site = `${functionName || '(anonymous)'} ${url || parentUrl}:${lineNumber + 1}`;
        sites.set(site, (sites.get(site) || 0) + node.selfSize);
      }
      for (const child of node.children) visit(child, url || parentUrl);
    })(profile.head, '');
    return { perFrame: bytes / frames, sites: [...sites] };
  } finally {
    session.disconnect();
  }
}

test('a shaped frame allocates nothing and runs no trigonometry', async (t) => {
  const route = shapesRoute({ S1: L_STREET });
  t.mock.method(globalThis, 'fetch', route.fetchImpl);
  const FLEET = 600;
  const fleet = (ctx, feedId) =>
    Array.from({ length: FLEET }, (_, i) =>
      vehicle(ctx, { key: `${feedId}:v${i}`, feedId }),
    );
  const shapedCtx = layer();
  const shaped = fleet(shapedCtx, 'trafiklab-sl');
  const straightCtx = layer();
  const straight = fleet(straightCtx, 'mbta');
  for (const [ctx, entries] of [
    [shapedCtx, shaped],
    [straightCtx, straight],
  ])
    for (const entry of entries) {
      showAt(entry, FIXES[1].t);
      ctx.trails.prepareEntry(entry);
    }
  await settle();
  assert.ok(shaped.every((entry) => pathFrom(entry, 1).shape));
  assert.ok(straight.every((entry) => !pathFrom(entry, 1).shape));

  const out = { x: 0, y: 0, z: 0 };
  const run = (ctx, entries) => {
    for (const entry of entries) {
      entry.clocks.monoNowMs = 0;
      seek(entry.track, FIXES[1].t + 1000, entry.clocks);
      setRate(entry.track, 1, entry.clocks);
    }
    let mono = 0;
    return () => {
      mono += 16;
      const wall = FIXES[1].t + 31_000 + mono;
      for (const entry of entries) {
        updatePlayback(entry, wall, mono);
        ctx.trails.samplePosition(entry, entry.sample, out, true);
      }
    };
  };
  const shapedFrame = run(shapedCtx, shaped);
  const straightFrame = run(straightCtx, straight);
  // Warm: the engine optimises the frame path before it is measured.
  for (let i = 0; i < 400; i++) {
    shapedFrame();
    straightFrame();
  }
  assert.equal(shaped[0].sample.phase, 'playing');
  assert.equal(shaped[0].routeShapeDrawn, true);

  const shapedBytes = await layerFrameBytes(shapedFrame, 120);
  const straightBytes = await layerFrameBytes(straightFrame, 120);
  t.diagnostic(
    `${FLEET}-vehicle frame bytes, shaped/straight: ${Math.round(shapedBytes.perFrame)}/${Math.round(straightBytes.perFrame)}`,
  );
  // What the straight frame allocates, and well inside the fleet QA's gate
  // of 8 KiB a frame (a position boxed per vehicle would be some 20 KiB).
  assert.ok(
    shapedBytes.perFrame <= Math.min(8192, straightBytes.perFrame + 512),
    JSON.stringify({ shapedBytes, straightBytes }),
  );

  // No trigonometry per frame: courses and positions were worked out once.
  // Spied on last: replacing Math's functions throws away optimised code.
  const trig = ['cos', 'sin', 'atan2', 'hypot'].map((name) =>
    t.mock.method(Math, name),
  );
  for (let i = 0; i < 10; i++) shapedFrame();
  assert.deepEqual(
    trig.map((mock) => mock.mock.callCount()),
    [0, 0, 0, 0],
  );
});
