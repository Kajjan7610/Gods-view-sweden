// Swedish fork: the Cockpit's driver's view (cockpitRides.js) on the Transit
// layer's selected vehicle and the Rail layer's selected train, over fake
// layers whose snapshots have the layers' shapes: what entry would ride, the
// hold and release around the view, the frame that places the eye, and a
// HUD that says only what is known, in the page's language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCockpitRides } from './cockpitRides.js';
import {
  COCKPIT_SUBJECT_MAX_READOUTS,
  cockpitSubjectCandidate,
  cockpitSubjectFrame,
  cockpitSubjectHudView,
  cockpitSubjectProviders,
} from '../cockpitSubjectProviders.js';
import { createRailPath, pointAtS } from '../data/railPaths.js';
import { RAIL_FEED_REGISTRY } from '../data/railFeeds.js';
import { TRANSIT_FEED_REGISTRY } from '../data/transitFeeds.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { setLocale } from '../i18n/index.js';
import { LOCALES } from '../i18n/locale.js';
import { isValidWorldFocusTarget } from '../worldFocus.js';

const SL = Object.freeze({
  id: 'trafiklab-sl',
  name: 'SL',
  operator: 'SL (GTFS Regional, via Trafiklab / Samtrafiken)',
  region: 'Stockholm, Sweden',
  attribution: 'Trafiklab / Samtrafiken GTFS Regional (CC0 1.0)',
  license: 'CC0 1.0',
  licenseUrl: 'https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/',
});
const TRAFIKVERKET = Object.freeze({
  id: 'trafikverket-trains',
  name: 'Trafikverket',
  operator: 'Trafikverket (Swedish national train positions)',
  region: 'Sweden',
  attribution: 'Trafikverket open API (CC0 1.0)',
  license: 'CC0 1.0',
  licenseUrl:
    'https://www.trafikverket.se/e-tjanster/trafikverkets-oppna-api-for-trafikinformation/',
});
const BUS_KEY = 'trafiklab-sl:9031001004805101';
const TRAIN_KEY = 'rail:trafikverket-trains:2861-20261124';

/** A Transit snapshot (src/layers/transit/cockpitSubject.js). */
function vehicle({ position, motion, stop, ...rest } = {}) {
  return Object.freeze({
    key: BUS_KEY,
    feedId: 'trafiklab-sl',
    selectedAtMs: 1_000,
    id: '9031001004805101',
    routeId: 'bus:4',
    routeLabel: '4',
    tripId: '14010000654321',
    directionId: 0,
    label: null,
    mode: 'bus',
    modeInferred: false,
    feed: SL,
    position: Object.freeze({
      latitude: 59.3326,
      longitude: 18.0649,
      groundHeightM: 24.5,
      atMs: 1,
      ...position,
    }),
    motion: Object.freeze({
      reportedSpeedMps: 9,
      derivedSpeedMps: 8,
      speedSource: 'reported',
      courseDeg: 72,
      reportedBearingDeg: 64,
      segmentCourseDeg: 72,
      phase: 'playing',
      word: 'EN ROUTE',
      reportAgeMs: 12_400,
      shownBehindMs: 45_200,
      feedStale: false,
      ...motion,
    }),
    stop: Object.freeze({ stopId: null, status: null, ...stop }),
    provenance: Object.freeze({ positionSource: 'gps', timestampSource: null }),
    ...rest,
  });
}

/** A Rail snapshot (src/layers/rail/cockpitSubject.js): a Swedish train. */
function train({ position, motion, ...rest } = {}) {
  return Object.freeze({
    key: TRAIN_KEY,
    feedId: 'trafikverket-trains',
    selectedAtMs: 2_000,
    id: '2861-20261124',
    tripId: '2861-20261124',
    routeId: '2861',
    routeName: null,
    label: 'Tåg 2861',
    trainNumber: null,
    headsign: null,
    category: 'regional',
    mode: 'rail',
    feed: TRAFIKVERKET,
    position: Object.freeze({
      latitude: 59.6099,
      longitude: 16.5448,
      railHeightM: 18,
      heightQuality: 2,
      atMs: 1,
      ...position,
    }),
    // Trafikverket publishes no shapes: a Swedish train has no line.
    path: null,
    motion: Object.freeze({
      reportedSpeedMps: 30,
      derivedSpeedMps: null,
      speedSource: 'reported',
      courseDeg: 101,
      phase: 'playing',
      word: 'EN ROUTE',
      reportAgeMs: 20_000,
      shownBehindMs: 60_000,
      feedStale: false,
      ...motion,
    }),
    provenance: Object.freeze({ positionSource: 'gps', timestampSource: null }),
    stops: Object.freeze([]),
    match: null,
    ...rest,
  });
}

/**
 * A Transit layer's read and hold API: `state.selected` is the selected
 * vehicle, `state.held` the one getCockpitSubject reads (tests swap it).
 */
function transitLayer(selected = vehicle()) {
  const calls = [];
  const state = { selected, held: null };
  return {
    calls,
    state,
    getSelectedVehicle: () => state.selected,
    getCockpitSubject: () => state.held,
    setCockpitSubject(key) {
      calls.push(['subject', key]);
      if (key === null || key === undefined) {
        state.held = null;
        return true;
      }
      if (state.selected?.key !== key) return false;
      state.held = state.selected;
      return true;
    },
    focusVehicle(key) {
      calls.push(['focus', key]);
      return true;
    },
  };
}

/**
 * A Rail layer's, with the Swedish fork's findByQuery naming the train as
 * `state.name` (the destination comes with Trafikverket's station calls).
 */
function railLayer(selected = train()) {
  const calls = [];
  const state = { selected, held: null, name: 'Tåg 2861 mot Stockholm C' };
  return {
    calls,
    state,
    getSelectedTrain: () => state.selected,
    getCockpitSubject: () => state.held,
    setCockpitSubject(key) {
      calls.push(['subject', key]);
      if (key === null || key === undefined) {
        state.held = null;
        return true;
      }
      if (state.selected?.key !== key) return false;
      state.held = state.selected;
      return true;
    },
    focusTrain(key) {
      calls.push(['focus', key]);
      return true;
    },
    findByQuery: (query) =>
      query === TRAIN_KEY
        ? { name: state.name, latitude: 59.6, longitude: 16.5 }
        : null,
  };
}

const rideOn = (kind, layers) =>
  createCockpitRides(layers).find((ride) => ride.kind === kind);
const transitRide = (layer = transitLayer()) =>
  rideOn('transit-ride', { transit: layer });
const railRide = (layer = railLayer()) => rideOn('rail-ride', { rail: layer });
/** What `read()` and `hud()` receive besides the frame. */
const CONTEXT = Object.freeze({
  groundHeightAt: () => null,
  warmGround() {},
  liftM: 0,
  look: Object.freeze({ yawDeg: 0, pitchDeg: -3, offset: false }),
});

/** Hold `ride`'s selected subject and read its frame, as entry does. */
function enter(ride) {
  const candidate = cockpitSubjectCandidate(ride.candidate());
  assert.ok(candidate, 'a candidate');
  assert.equal(ride.isEntryAllowed(candidate), true);
  assert.equal(ride.hold(candidate.id), true);
  const frame = cockpitSubjectFrame(ride.read(0, CONTEXT), candidate.id);
  assert.ok(frame, 'a frame');
  return frame;
}

/** The HUD view `ride` gives for its held subject's next frame. */
function hudOf(ride, look = CONTEXT.look) {
  const raw = ride.read(0, CONTEXT);
  assert.ok(raw, 'a frame');
  return ride.hud(cockpitSubjectFrame(raw, raw.id), { ...CONTEXT, look });
}

const inLocale = (t, locale) => {
  setLocale(locale);
  t.after(() => setLocale('en'));
};

test('both rides pass the Cockpit’s check, and a missing layer has none', () => {
  const warnings = [];
  const kept = cockpitSubjectProviders(
    createCockpitRides({ rail: railLayer(), transit: transitLayer() }),
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    kept.map(({ kind, layerId }) => [kind, layerId]),
    [
      ['transit-ride', 'transit'],
      ['rail-ride', 'rail'],
    ],
  );
  const [transit, rail] = kept;
  assert.deepEqual(transit.entryFace, {
    icon: 'directions_bus',
    label: "DRIVER'S VIEW",
  });
  assert.deepEqual(rail.entryFace, { icon: 'train', label: "DRIVER'S VIEW" });
  assert.deepEqual(transit.labels, {
    view: "Driver's view",
    exit: "Exit driver's view",
    exitText: 'EXIT',
    kicker: "DRIVER'S VIEW",
  });
  assert.deepEqual(rail.look, { restPitchDeg: -3, aheadLabel: 'Look ahead' });
  assert.equal(transit.cameraIntervalMs, 0, 'the eye moves every frame');

  const kinds = (layers) => createCockpitRides(layers).map(({ kind }) => kind);
  assert.deepEqual(kinds({ transit: transitLayer() }), ['transit-ride']);
  assert.deepEqual(kinds({ rail: railLayer() }), ['rail-ride']);
  assert.deepEqual(kinds({ rail: null, transit: undefined }), []);
  assert.deepEqual(kinds(), []);
});

test('entry would ride nothing, a bus or a train, and never throws', () => {
  const transitLayerNow = transitLayer(null);
  const ride = transitRide(transitLayerNow);
  assert.equal(ride.candidate(), null, 'nothing selected');
  assert.equal(ride.isEntryAllowed({ id: BUS_KEY }), false);

  transitLayerNow.state.selected = vehicle();
  const bus = cockpitSubjectCandidate(ride.candidate());
  assert.deepEqual(bus, {
    id: BUS_KEY,
    name: 'Route 4',
    face: { icon: 'directions_bus', label: "DRIVER'S VIEW" },
    selectedAt: 1_000,
  });
  assert.equal(ride.isEntryAllowed(bus), true);
  assert.equal(ride.isEntryAllowed({ id: 'another' }), false);
  assert.equal(
    ride.candidate(),
    ride.candidate(),
    'the same candidate while nothing changed',
  );
  transitLayerNow.state.selected = vehicle({ selectedAtMs: 5_000 });
  assert.equal(ride.candidate().selectedAt, 5_000, 'selected again');
  transitLayerNow.state.selected = vehicle({
    position: { latitude: Number.NaN },
  });
  assert.equal(ride.isEntryAllowed(bus), false, 'no place to stand');

  const trainRide = railRide();
  const named = cockpitSubjectCandidate(trainRide.candidate());
  assert.deepEqual(named, {
    id: TRAIN_KEY,
    name: 'Tåg 2861 mot Stockholm C',
    face: { icon: 'train', label: "DRIVER'S VIEW" },
    selectedAt: 2_000,
  });
  assert.equal(trainRide.isEntryAllowed(named), true);

  const throwing = () => {
    throw new Error('layer off');
  };
  const broken = [
    {},
    {
      getSelectedVehicle: throwing,
      getSelectedTrain: throwing,
      getCockpitSubject: throwing,
      setCockpitSubject: throwing,
      focusVehicle: throwing,
      focusTrain: throwing,
      findByQuery: throwing,
    },
    {
      getSelectedVehicle: () => ({
        get key() {
          throw new Error('getter');
        },
      }),
      getSelectedTrain: () => 'not a snapshot',
    },
  ];
  for (const layer of broken)
    for (const kind of ['transit-ride', 'rail-ride']) {
      const failing = rideOn(kind, { transit: layer, rail: layer });
      assert.equal(failing.candidate(), null, kind);
      assert.equal(failing.isEntryAllowed({ id: BUS_KEY }), false, kind);
      assert.equal(failing.hold(BUS_KEY), false, kind);
      assert.equal(failing.read(0, CONTEXT), null, kind);
      assert.equal(failing.hud({ id: BUS_KEY }, CONTEXT), null, kind);
      assert.doesNotThrow(() => failing.release(BUS_KEY, { restore: true }));
    }
});

test('the entry face shows what runs: a bus, a train or a boat', () => {
  const faceOf = (ride) => ride.candidate().face.icon;
  const transitFaces = {
    bus: 'directions_bus',
    trolleybus: 'directions_bus',
    tram: 'train',
    subway: 'train',
    rail: 'train',
    ferry: 'directions_boat',
    // A gondola or an unknown mode takes the Transit ride's own.
    aerial_lift: 'directions_bus',
    unknown: 'directions_bus',
  };
  for (const [mode, icon] of Object.entries(transitFaces))
    assert.equal(faceOf(transitRide(transitLayer(vehicle({ mode })))), icon);
  for (const mode of ['rail', 'metro', 'tram', null])
    assert.equal(faceOf(railRide(railLayer(train({ mode })))), 'train');
});

test('hold takes the vehicle only on true; release is harmless again and restores when asked', () => {
  const layer = transitLayer();
  const ride = transitRide(layer);
  assert.equal(ride.hold('trafiklab-sl:other'), false, 'the layer refused');
  assert.equal(ride.hold(BUS_KEY), true);
  assert.equal(layer.state.held?.key, BUS_KEY);

  // Another vehicle's release leaves the one held alone.
  ride.release('trafiklab-sl:other', { restore: false });
  assert.equal(layer.state.held?.key, BUS_KEY);

  layer.calls.length = 0;
  ride.release(BUS_KEY, { restore: false });
  ride.release(BUS_KEY, { restore: false });
  ride.release(BUS_KEY);
  assert.deepEqual(layer.calls, [
    ['subject', null],
    ['subject', null],
    ['subject', null],
  ]);
  assert.equal(ride.read(0, CONTEXT), null, 'nothing held after release');

  ride.hold(BUS_KEY);
  layer.calls.length = 0;
  ride.release(BUS_KEY, { restore: true });
  assert.deepEqual(layer.calls, [
    ['subject', null],
    ['focus', BUS_KEY],
  ]);

  const answers = [undefined, 'yes', 1, Promise.resolve(true)];
  for (const answer of answers) {
    const odd = transitRide({
      ...transitLayer(),
      setCockpitSubject: () => answer,
    });
    assert.equal(odd.hold(BUS_KEY), false, String(answer));
  }

  const trains = railLayer();
  const trainRide = railRide(trains);
  trainRide.hold(TRAIN_KEY);
  trains.calls.length = 0;
  trainRide.release(TRAIN_KEY, { restore: true });
  assert.deepEqual(trains.calls, [
    ['subject', null],
    ['focus', TRAIN_KEY],
  ]);
});

test('a frame stands a driver’s eye on the drawn vehicle, facing its drawn course', () => {
  const frame = enter(transitRide());
  assert.equal(frame.id, BUS_KEY);
  assert.equal(frame.name, 'Route 4');
  assert.equal(frame.latitude, 59.3326);
  assert.ok(Math.abs(frame.longitude - 18.0649) < 1e-9);
  assert.equal(frame.heightM, 24.5);
  assert.equal(frame.headingDeg, 72, 'the drawn course, not the report’s');
  assert.equal(frame.speedMps, 9, 'the reported speed, as the card gives it');
  assert.equal(frame.anchor, 'exact');
  assert.equal(frame.stale, false);
  assert.deepEqual(frame.eye, {
    upM: 2.4,
    forwardM: 0,
    pitchDeg: -3,
    minClearanceM: 1.5,
  });

  const eyes = {
    bus: 2.4,
    trolleybus: 2.4,
    tram: 2.5,
    subway: 2.4,
    rail: 3,
    ferry: 6,
    aerial_lift: 2.5,
    unknown: 2.5,
  };
  for (const [mode, upM] of Object.entries(eyes))
    assert.equal(
      enter(transitRide(transitLayer(vehicle({ mode })))).eye.upM,
      upM,
      mode,
    );
  for (const [mode, upM] of [
    ['rail', 3],
    ['tram', 2.5],
    ['metro', 2.4],
    [null, 3],
  ])
    assert.equal(
      enter(railRide(railLayer(train({ mode })))).eye.upM,
      upM,
      String(mode),
    );

  const cold = enter(
    transitRide(transitLayer(vehicle({ position: { groundHeightM: null } }))),
  );
  assert.equal(cold.heightM, null, 'no floor known: the Cockpit waits');
  const workedOut = enter(
    transitRide(transitLayer(vehicle({ motion: { reportedSpeedMps: null } }))),
  );
  assert.equal(workedOut.speedMps, 8, 'none reported: the motion drawn');
  const noSpeed = enter(
    transitRide(
      transitLayer(
        vehicle({ motion: { derivedSpeedMps: null, reportedSpeedMps: null } }),
      ),
    ),
  );
  assert.equal(noSpeed.speedMps, null);
  assert.equal(noSpeed.anchor, 'exact');

  const ride = transitRide(transitLayer());
  const reads = [ride.read(0, CONTEXT)];
  enter(ride);
  reads.push(ride.read(0, CONTEXT), ride.read(16, CONTEXT));
  assert.equal(reads[0], null, 'nothing held yet');
  assert.equal(reads[1].eye, reads[2].eye, 'one eye, not one a frame');
  assert.ok(Object.isFrozen(reads[1].eye));
});

test('the view ends when the held vehicle goes or another is held', () => {
  const layer = transitLayer();
  const ride = transitRide(layer);
  enter(ride);
  layer.state.held = vehicle({ key: 'trafiklab-sl:another' });
  assert.equal(ride.read(0, CONTEXT), null, 'another vehicle');
  layer.state.held = null;
  assert.equal(ride.read(0, CONTEXT), null, 'gone');
  layer.state.held = vehicle();
  assert.ok(
    cockpitSubjectFrame(ride.read(0, CONTEXT), BUS_KEY),
    'back while still held',
  );
});

test('a Swedish train stands where it is drawn; a train on its line stands on the line', () => {
  const swedish = enter(railRide());
  assert.equal(swedish.name, 'Tåg 2861 mot Stockholm C');
  assert.equal(swedish.latitude, 59.6099);
  assert.ok(Math.abs(swedish.longitude - 16.5448) < 1e-9);
  assert.equal(swedish.headingDeg, 101, 'its drawn course');
  assert.equal(swedish.heightM, 18, 'the rail height');
  assert.equal(swedish.speedMps, 30, 'as reported: none was worked out');
  const cold = enter(
    railRide(railLayer(train({ position: { railHeightM: null } }))),
  );
  assert.equal(cold.heightM, null);

  // A line due east, 6 km long, one vertex per 100 m.
  const coords = [];
  for (let d = 0; d <= 6000; d += 100)
    coords.push(
      42.36,
      -71.08 + d / (111_320 * Math.cos((42.36 * Math.PI) / 180)),
    );
  const line = createRailPath(coords);
  const expected = pointAtS(line, 1234);
  for (const [direction, headingDeg] of [
    [1, 90],
    [-1, 270],
  ]) {
    const onLine = train({
      key: 'rail:mbta-rail:T1',
      feed: { name: 'MBTA', attribution: 'MBTA', license: 'MBTA terms' },
      // The drawn place lags the line's: the line decides.
      position: { latitude: 0, longitude: 0 },
      motion: { courseDeg: 10 },
      path: Object.freeze({ s: 1234, direction, line }),
    });
    const frame = enter(railRide(railLayer(onLine)));
    assert.ok(Math.abs(frame.latitude - expected.lat) < 1e-9);
    assert.ok(Math.abs(frame.longitude - expected.lon) < 1e-9);
    assert.ok(
      Math.abs(frame.headingDeg - headingDeg) < 1e-6,
      `direction ${direction}`,
    );
  }
});

test('the HUD says what is shown and how it is known', () => {
  const layer = transitLayer();
  const ride = transitRide(layer);
  enter(ride);
  const raw = hudOf(ride);
  const view = cockpitSubjectHudView(raw);
  assert.equal(view.kicker, 'BUS · SL');
  assert.equal(view.title, 'Route 4');
  assert.deepEqual(view.meta, {
    text: 'SHOWN 45 S BEHIND REAL TIME · STRAIGHT LINE BETWEEN POSITION REPORTS',
    tone: 'estimate',
  });
  assert.deepEqual(view.speed, {
    value: 32,
    unit: 'km/h',
    tag: 'REPORTED',
    tone: 'normal',
  });
  assert.deepEqual(
    view.readouts.map(({ id, label, value }) => [id, label, value]),
    [
      ['line', 'LINE', '4'],
      ['last-report', 'LAST REPORT', '12 s ago'],
      ['motion', 'STATUS', 'Moving'],
    ],
  );
  assert.deepEqual(view.sources, [
    {
      id: 'feed',
      label: 'SOURCE',
      text: 'Trafiklab / Samtrafiken GTFS Regional (CC0 1.0)',
      tone: 'normal',
    },
  ]);
  assert.deepEqual(view.signals, []);
  assert.equal(view.route, null, 'no route card');
  assert.equal(view.progress, null, 'no progress line');
  assert.equal(view.lookReadout, '');

  const read = (overrides) => {
    layer.state.selected = vehicle(overrides);
    layer.state.held = layer.state.selected;
    return cockpitSubjectHudView(hudOf(ride));
  };
  assert.equal(
    read({ motion: { shownBehindMs: null } }).meta.text,
    'SHOWN BEHIND REAL TIME · STRAIGHT LINE BETWEEN POSITION REPORTS',
    'no seconds when they are unknown',
  );
  assert.deepEqual(read({ motion: { reportedSpeedMps: null } }).speed, {
    value: 29,
    unit: 'km/h',
    tag: 'COMPUTED',
    tone: 'estimate',
  });
  assert.deepEqual(
    read({ motion: { derivedSpeedMps: null, reportedSpeedMps: null } }).speed,
    { value: null, unit: 'km/h', tag: '', tone: 'muted' },
  );
  assert.equal(
    read({ motion: { reportAgeMs: 185_000 } }).readouts[1].value,
    '3 min ago',
  );
  assert.equal(
    read({ motion: { word: 'STOPPED' } }).readouts.at(-1).value,
    'Stopped',
  );
  const quiet = read({ routeId: null, routeLabel: null, label: '7021' });
  assert.equal(quiet.title, 'Vehicle 7021');
  assert.deepEqual(
    quiet.readouts.map(({ id }) => id),
    ['last-report', 'motion'],
  );
  assert.equal(read({ label: '7021' }).title, 'Route 4 · 7021');
  // A mode the feed only defaults to is not said, nor an unknown one: the
  // kicker names the view.
  assert.equal(read({ modeInferred: true }).kicker, "DRIVER'S VIEW · SL");
  assert.equal(read({ mode: 'unknown' }).kicker, "DRIVER'S VIEW · SL");
  assert.equal(
    read({ mode: 'unknown', routeId: null, routeLabel: null }).title,
    'Transit vehicle',
  );
  assert.equal(read({ mode: 'tram' }).kicker, 'TRAM · SL');
  // A credit that does not name its licence: the licence on a row of its own.
  assert.deepEqual(
    read({
      feed: {
        name: 'Example',
        attribution: 'Example Transit',
        license: 'CC BY 4.0',
      },
    }).sources.map(({ id, label, text }) => [id, label, text]),
    [
      ['feed', 'SOURCE', 'Example Transit'],
      ['licence', 'LICENCE', 'CC BY 4.0'],
    ],
  );

  const trains = railLayer();
  const trainRide = railRide(trains);
  enter(trainRide);
  const swedish = cockpitSubjectHudView(hudOf(trainRide));
  assert.equal(swedish.kicker, 'TRAIN · Trafikverket');
  assert.equal(swedish.title, 'Tåg 2861 mot Stockholm C');
  assert.deepEqual(
    swedish.readouts.map(({ id }) => id),
    ['last-report', 'motion'],
    'a train number is no line',
  );
  assert.equal(swedish.sources[0].text, 'Trafikverket open API (CC0 1.0)');
  assert.match(swedish.meta.text, /STRAIGHT LINE/);
  trains.state.selected = train({
    path: Object.freeze({
      s: 10,
      direction: 1,
      line: createRailPath([59.6, 16.5, 59.61, 16.5]),
    }),
  });
  trains.state.held = trains.state.selected;
  assert.equal(
    cockpitSubjectHudView(hudOf(trainRide)).meta.text,
    'SHOWN 60 S BEHIND REAL TIME',
    'a train on its line glides along it, not straight',
  );
});

test('a waiting vehicle reads its reported speed, never a worked-out 0', (t) => {
  /** The frame's speed and the HUD's, which must agree. */
  const speedsOf = (ride) => {
    const frame = enter(ride);
    return [frame.speedMps, cockpitSubjectHudView(hudOf(ride)).speed];
  };
  const bus = (motion) => transitRide(transitLayer(vehicle({ motion })));
  const waiting = { derivedSpeedMps: 0, phase: 'held', word: 'WAITING' };
  // Held for its next report, playback works out 0: the report's 6 km/h.
  assert.deepEqual(speedsOf(bus({ ...waiting, reportedSpeedMps: 1.67 })), [
    1.67,
    { value: 6, unit: 'km/h', tag: 'REPORTED', tone: 'normal' },
  ]);
  // None reported: worked out only while playback plays two reports.
  for (const phase of ['held', 'buffering', 'paused', null])
    assert.deepEqual(
      speedsOf(bus({ ...waiting, phase, reportedSpeedMps: null })),
      [null, { value: null, unit: 'km/h', tag: '', tone: 'muted' }],
      String(phase),
    );
  // Playing across a break between two reports: the layer's word is
  // WAITING, and the 0 worked out there is no speed either.
  assert.deepEqual(
    speedsOf(bus({ ...waiting, phase: 'playing', reportedSpeedMps: null })),
    [null, { value: null, unit: 'km/h', tag: '', tone: 'muted' }],
  );
  const playing = { reportedSpeedMps: null, phase: 'playing' };
  assert.deepEqual(
    speedsOf(bus({ ...playing, derivedSpeedMps: 7, word: 'EN ROUTE' })),
    [7, { value: 25, unit: 'km/h', tag: 'COMPUTED', tone: 'estimate' }],
  );
  // Two reports at one place: a 0 that was worked out.
  assert.deepEqual(
    speedsOf(bus({ ...playing, derivedSpeedMps: 0, word: 'STOPPED' })),
    [0, { value: 0, unit: 'km/h', tag: 'COMPUTED', tone: 'estimate' }],
  );
  // A train the same.
  assert.deepEqual(
    speedsOf(
      railRide(
        railLayer(train({ motion: { ...waiting, reportedSpeedMps: 30 } })),
      ),
    ),
    [30, { value: 108, unit: 'km/h', tag: 'REPORTED', tone: 'normal' }],
  );

  // As the driver's view showed it in Swedish: "ANGIVEN 6", not
  // "BERÄKNAD 0".
  inLocale(t, 'sv');
  const [, speed] = speedsOf(bus({ ...waiting, reportedSpeedMps: 1.67 }));
  assert.deepEqual([speed.value, speed.tag], [6, 'ANGIVEN']);
});

test('a bus drawn along its route shape says so, as an estimate, in English and Swedish', (t) => {
  const layer = transitLayer(vehicle({ motion: { alongRouteShape: true } }));
  const ride = transitRide(layer);
  enter(ride);
  assert.deepEqual(cockpitSubjectHudView(hudOf(ride)).meta, {
    text: 'SHOWN 45 S BEHIND REAL TIME · ALONG THE ROUTE, ESTIMATED BETWEEN REPORTS',
    tone: 'estimate',
  });
  // Off the shape again (a detour, or no shape): straight, as before.
  layer.state.selected = vehicle({ motion: { alongRouteShape: false } });
  layer.state.held = layer.state.selected;
  assert.equal(
    cockpitSubjectHudView(hudOf(ride)).meta.text,
    'SHOWN 45 S BEHIND REAL TIME · STRAIGHT LINE BETWEEN POSITION REPORTS',
  );
  // No recent fix says only that, shape or not.
  layer.state.selected = vehicle({
    motion: { alongRouteShape: true, word: 'NO FIX' },
  });
  layer.state.held = layer.state.selected;
  assert.equal(cockpitSubjectHudView(hudOf(ride)).meta.text, 'NO RECENT FIX');

  inLocale(t, 'sv');
  layer.state.selected = vehicle({ motion: { alongRouteShape: true } });
  layer.state.held = layer.state.selected;
  assert.equal(
    cockpitSubjectHudView(hudOf(ride)).meta.text,
    'VISAS 45 S EFTER REALTID · LÄNGS LINJENS STRÄCKNING, UPPSKATTAT MELLAN RAPPORTER',
  );
  layer.state.selected = vehicle();
  layer.state.held = layer.state.selected;
  assert.equal(
    cockpitSubjectHudView(hudOf(ride)).meta.text,
    'VISAS 45 S EFTER REALTID · RAK LINJE MELLAN POSITIONSRAPPORTER',
    'a snapshot without the flag is drawn straight',
  );
});

test('a stop is the id the newest report named, never a name', () => {
  const captions = [
    ['IN_TRANSIT_TO', 'NEXT STOP'],
    ['INCOMING_AT', 'ARRIVING AT'],
    ['STOPPED_AT', 'AT STOP'],
    [null, 'STOP'],
  ];
  for (const [status, label] of captions) {
    const ride = transitRide(
      transitLayer(vehicle({ stop: { stopId: '9022001012345001', status } })),
    );
    enter(ride);
    const view = cockpitSubjectHudView(hudOf(ride));
    assert.ok(view.readouts.length <= COCKPIT_SUBJECT_MAX_READOUTS);
    assert.deepEqual(
      view.readouts.find(({ id }) => id === 'stop'),
      {
        id: 'stop',
        label,
        value: '9022001012345001',
        detail: 'PER THE LAST REPORT',
        tone: 'normal',
      },
      String(status),
    );
  }
});

test('a vehicle with no recent fix says so, not how far behind it is shown', (t) => {
  for (const ride of [
    transitRide(
      transitLayer(
        vehicle({ motion: { word: 'NO FIX', shownBehindMs: 120_000 } }),
      ),
    ),
    railRide(
      railLayer(train({ motion: { word: 'NO FIX', shownBehindMs: 120_000 } })),
    ),
  ]) {
    enter(ride);
    const view = cockpitSubjectHudView(hudOf(ride));
    assert.deepEqual(view.meta, {
      text: 'NO RECENT FIX',
      tone: 'warning',
    });
  }
  inLocale(t, 'sv');
  const ride = railRide(
    railLayer(train({ motion: { word: 'NO FIX', shownBehindMs: 120_000 } })),
  );
  enter(ride);
  assert.equal(
    cockpitSubjectHudView(hudOf(ride)).meta.text,
    'INGEN AKTUELL POSITION',
  );
});

test('a feed that has stopped updating raises a warning', () => {
  const ride = transitRide(
    transitLayer(vehicle({ motion: { feedStale: true } })),
  );
  const frame = enter(ride);
  assert.equal(frame.stale, true);
  assert.deepEqual(cockpitSubjectHudView(hudOf(ride)).signals, [
    {
      id: 'feed-stale',
      title: 'FEED NOT UPDATED',
      detail: 'SL',
      tone: 'warning',
    },
  ]);
});

test('in Swedish the ride reads BUSS · SL and says the rest in Swedish', (t) => {
  inLocale(t, 'sv');
  const [transit, rail] = cockpitSubjectProviders(
    createCockpitRides({
      transit: transitLayer(
        vehicle({
          stop: { stopId: '9022001012345001', status: 'IN_TRANSIT_TO' },
          // No reported speed: the one worked out between reports.
          motion: { feedStale: true, reportedSpeedMps: null },
        }),
      ),
      rail: railLayer(),
    }),
  );
  assert.deepEqual(transit.entryFace, {
    icon: 'directions_bus',
    label: 'FÖRARVY',
  });
  assert.deepEqual(transit.labels, {
    view: 'Förarvy',
    exit: 'Lämna förarvyn',
    exitText: 'LÄMNA',
    kicker: 'FÖRARVY',
  });
  assert.equal(transit.look.aheadLabel, 'Titta framåt');

  const candidate = cockpitSubjectCandidate(transit.candidate());
  assert.equal(candidate.name, 'Linje 4');
  assert.equal(candidate.face.label, 'FÖRARVY');
  transit.hold(candidate.id);
  const frame = cockpitSubjectFrame(transit.read(0, CONTEXT), candidate.id);
  const view = cockpitSubjectHudView(
    transit.hud(frame, {
      ...CONTEXT,
      look: { yawDeg: 45, pitchDeg: -3, offset: true },
    }),
  );
  assert.equal(view.kicker, 'BUSS · SL');
  assert.equal(view.title, 'Linje 4');
  assert.equal(
    view.meta.text,
    'VISAS 45 S EFTER REALTID · RAK LINJE MELLAN POSITIONSRAPPORTER',
  );
  assert.equal(view.speed.tag, 'BERÄKNAD');
  assert.deepEqual(
    view.readouts.map(({ label, value, detail }) => [label, value, detail]),
    [
      ['LINJE', '4', ''],
      ['SENASTE RAPPORT', 'för 12 s sedan', ''],
      ['NÄSTA HÅLLPLATS', '9022001012345001', 'ENLIGT SENASTE RAPPORTEN'],
      ['LÄGE', 'I rörelse', ''],
    ],
  );
  assert.equal(view.sources[0].label, 'KÄLLA');
  assert.equal(view.signals[0].title, 'FLÖDET HAR INTE UPPDATERATS');
  assert.equal(view.lookReadout, 'TITTA HÖGER 45°');

  const trainCandidate = cockpitSubjectCandidate(rail.candidate());
  assert.equal(trainCandidate.name, 'Tåg 2861 mot Stockholm C');
  rail.hold(trainCandidate.id);
  const trainFrame = cockpitSubjectFrame(
    rail.read(0, CONTEXT),
    trainCandidate.id,
  );
  const trainView = cockpitSubjectHudView(rail.hud(trainFrame, CONTEXT));
  assert.equal(trainView.kicker, 'TÅG · Trafikverket');
  assert.equal(trainView.speed.tag, 'ANGIVEN');
  assert.equal(
    trainView.meta.text,
    'VISAS 60 S EFTER REALTID · RAK LINJE MELLAN POSITIONSRAPPORTER',
  );
});

test('the HUD view is the same object while nothing in it changed', (t) => {
  const layer = transitLayer();
  const ride = transitRide(layer);
  const frame = enter(ride);
  const first = ride.hud(frame, CONTEXT);
  assert.equal(ride.hud(frame, CONTEXT), first);
  assert.ok(Object.isFrozen(first));

  // The vehicle moved a little: nothing the HUD shows changed.
  layer.state.held = vehicle({ position: { latitude: 59.3327 } });
  ride.read(0, CONTEXT);
  assert.equal(ride.hud(frame, CONTEXT), first);

  layer.state.held = vehicle({ motion: { reportAgeMs: 13_600 } });
  ride.read(0, CONTEXT);
  const older = ride.hud(frame, CONTEXT);
  assert.notEqual(older, first, 'a second older');
  assert.equal(older.readouts[1].value, '14 s ago');

  const turned = ride.hud(frame, {
    ...CONTEXT,
    look: { yawDeg: -135, pitchDeg: -13, offset: true },
  });
  assert.notEqual(turned, older);
  assert.equal(turned.lookReadout, 'LOOK LEFT 135° · DOWN 13°');
  assert.equal(
    ride.hud(frame, {
      ...CONTEXT,
      look: { yawDeg: 180, pitchDeg: -3, offset: true },
    }).lookReadout,
    'LOOK BACK',
  );

  const english = ride.hud(frame, CONTEXT);
  inLocale(t, 'sv');
  const swedish = ride.hud(frame, CONTEXT);
  assert.notEqual(swedish, english, 'worded again in a new language');
  assert.equal(swedish.kicker, 'BUSS · SL');
});

test('every language’s words fit the Cockpit’s room for them', (t) => {
  t.after(() => setLocale('en'));
  const fits = (text, max, where) => {
    assert.equal(typeof text, 'string', where);
    assert.ok(text.length <= max, `${where}: "${text}" is over ${max}`);
  };
  for (const locale of LOCALES) {
    setLocale(locale);
    // The longest words: a long feed name, a licence on its own row, the
    // longest stop caption and motion word, the most seconds behind, a stale
    // feed.
    const longest = (overrides) =>
      transitRide(
        transitLayer(
          vehicle({
            mode: 'trolleybus',
            label: '9031001004805101',
            feed: {
              ...SL,
              name: 'Länstrafiken Kronoberg',
              attribution: 'Länstrafiken Kronoberg',
            },
            stop: { stopId: '9022001012345001', status: 'INCOMING_AT' },
            motion: {
              derivedSpeedMps: null,
              shownBehindMs: 120_000,
              word: 'WAITING',
              feedStale: true,
            },
            ...overrides,
          }),
        ),
      );
    const inferred = longest({ modeInferred: true });
    enter(inferred);
    fits(hudOf(inferred).kicker, 48, `${locale} kicker, mode not known`);
    // Swedish fork: the most seconds behind along a route shape.
    const shaped = longest({
      motion: {
        derivedSpeedMps: null,
        shownBehindMs: 120_000,
        word: 'WAITING',
        feedStale: true,
        alongRouteShape: true,
      },
    });
    enter(shaped);
    const shapedMeta = hudOf(shaped).meta.text;
    assert.ok(!/STRAIGHT|RAK LINJE/.test(shapedMeta), `${locale} shaped`);
    fits(shapedMeta, 96, `${locale} meta along the route`);
    const ride = longest();
    const face = ride.entryFace();
    fits(face.label, 16, `${locale} entry face`);
    const labels = ride.labels();
    fits(labels.view, 48, `${locale} view`);
    fits(labels.exit, 48, `${locale} exit`);
    fits(labels.exitText, 24, `${locale} exit text`);
    fits(labels.kicker, 48, `${locale} kicker`);
    fits(ride.look().aheadLabel, 64, `${locale} look ahead`);
    const frame = enter(ride);
    for (const look of [
      { yawDeg: -135, pitchDeg: -48, offset: true },
      { yawDeg: 180, pitchDeg: 37, offset: true },
    ]) {
      const view = ride.hud(frame, { ...CONTEXT, look });
      fits(view.kicker, 48, `${locale} HUD kicker`);
      fits(view.meta.text, 96, `${locale} meta`);
      fits(view.speed.tag, 8, `${locale} speed tag`);
      fits(view.speed.unit, 12, `${locale} speed unit`);
      for (const row of view.readouts) {
        fits(row.label, 24, `${locale} ${row.id} label`);
        fits(row.value, 48, `${locale} ${row.id} value`);
        fits(row.detail ?? '', 80, `${locale} ${row.id} detail`);
      }
      assert.equal(view.sources.length, 2, `${locale} credit and licence`);
      for (const row of view.sources) fits(row.label, 16, `${locale} source`);
      for (const row of view.signals) fits(row.title, 48, `${locale} signal`);
      fits(view.lookReadout, 48, `${locale} look`);
      assert.ok(view.lookReadout, `${locale} words a turned view`);
    }
    const underground = longest({ mode: 'subway' });
    enter(underground);
    const signals = hudOf(underground).signals;
    assert.deepEqual(
      signals.map(({ id }) => id),
      ['feed-stale', 'street-level'],
      locale,
    );
    for (const row of signals) {
      fits(row.title, 48, `${locale} ${row.id} title`);
      fits(row.detail, 96, `${locale} ${row.id} detail`);
    }
    // The worked-out speed's tag too: one with no reported speed.
    const trainRide = railRide(
      railLayer(
        train({ motion: { derivedSpeedMps: 25, reportedSpeedMps: null } }),
      ),
    );
    const trainFrame = enter(trainRide);
    const computed = trainRide.hud(trainFrame, CONTEXT);
    assert.equal(computed.speed.tone, 'estimate', `${locale} worked out`);
    fits(computed.speed.tag, 8, `${locale} computed tag`);
    fits(computed.kicker, 48, `${locale} train kicker`);
  }
});

test('leaving a bus or tram frames it from above; a train frames itself', () => {
  const layer = transitLayer();
  const requests = [];
  const ride = rideOn('transit-ride', {
    transit: layer,
    requestWorldFocus: (detail) => {
      layer.calls.push(['frame', detail.id]);
      requests.push(detail);
      return true;
    },
  });
  enter(ride);
  ride.release(BUS_KEY, { restore: false });
  assert.deepEqual(requests, [], 'nothing without restore');

  enter(ride);
  layer.calls.length = 0;
  ride.release(BUS_KEY, { restore: true });
  assert.deepEqual(
    layer.calls,
    [
      ['subject', null],
      ['focus', BUS_KEY],
      ['frame', BUS_KEY],
    ],
    'selected again, then framed',
  );
  const [detail] = requests;
  assert.equal(isValidWorldFocusTarget(detail), true);
  assert.equal(detail.kind, 'train');
  assert.equal(detail.label, 'Route 4');
  // Framed by its kind: a kept view would stay at street level.
  assert.equal(detail.keepView, undefined);
  const expected = fromDegrees(18.0649, 59.3326, 24.5);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(detail.position[axis] - expected[axis]) < 1e-6, axis);

  // Gone from the feed by then: framed where the view last saw it.
  enter(ride);
  requests.length = 0;
  layer.state.selected = null;
  ride.release(BUS_KEY, { restore: true });
  assert.deepEqual(
    requests.map(({ id }) => id),
    [BUS_KEY],
  );

  // No floor known yet: still a target the camera takes.
  const coldRequests = [];
  const cold = rideOn('transit-ride', {
    transit: transitLayer(vehicle({ position: { groundHeightM: null } })),
    requestWorldFocus: (target) => coldRequests.push(target),
  });
  enter(cold);
  cold.release(BUS_KEY, { restore: true });
  assert.equal(isValidWorldFocusTarget(coldRequests[0]), true);

  // A camera request that throws changes nothing else.
  const failing = transitLayer();
  const failingRide = rideOn('transit-ride', {
    transit: failing,
    requestWorldFocus: () => {
      throw new Error('camera');
    },
  });
  enter(failingRide);
  failing.calls.length = 0;
  assert.doesNotThrow(() => failingRide.release(BUS_KEY, { restore: true }));
  assert.deepEqual(failing.calls, [
    ['subject', null],
    ['focus', BUS_KEY],
  ]);
  enter(failingRide);

  // Without the service the vehicle is only selected.
  const bare = transitRide();
  enter(bare);
  assert.doesNotThrow(() => bare.release(BUS_KEY, { restore: true }));

  // Rail's focusTrain follows the train, or flies to it, itself.
  const trains = railLayer();
  const trainRequests = [];
  const trainRide = rideOn('rail-ride', {
    rail: trains,
    requestWorldFocus: (target) => trainRequests.push(target),
  });
  enter(trainRide);
  trainRide.release(TRAIN_KEY, { restore: true });
  assert.deepEqual(trainRequests, []);
  assert.deepEqual(trains.calls.at(-1), ['focus', TRAIN_KEY]);
});

test('a line is one the feed names: a train number or a database key is none', (t) => {
  const hud = (snapshot) => {
    const ride = transitRide(transitLayer(snapshot));
    enter(ride);
    return cockpitSubjectHudView(hudOf(ride));
  };
  const lineOf = (view) =>
    view.readouts.find(({ id }) => id === 'line')?.value ?? null;

  const bus = hud(vehicle());
  assert.equal(lineOf(bus), '4');
  assert.equal(bus.title, 'Route 4');

  // Trafikverket's trains in Transit: the route id is the train's number.
  const swedishTrain = vehicle({
    key: 'trafikverket-trains:2861-20261124',
    feedId: 'trafikverket-trains',
    routeId: '2861',
    routeLabel: '2861',
    label: 'Tåg 2861',
    mode: 'rail',
    feed: TRAFIKVERKET,
  });
  const train2861 = hud(swedishTrain);
  assert.equal(lineOf(train2861), null);
  assert.equal(train2861.title, 'Train 2861');
  assert.equal(train2861.kicker, 'TRAIN · Trafikverket');

  // A GTFS key the feed's names do not know (SL), and one a feed's names
  // hand back as they are (Burlington): no "Route 9011…" either way.
  for (const feedId of ['trafiklab-sl', 'burlington-transit']) {
    const keyed = hud(
      vehicle({
        feedId,
        routeId: '9011001000400000',
        routeLabel: '9011001000400000',
        label: '7021',
      }),
    );
    assert.equal(lineOf(keyed), null, feedId);
    assert.equal(keyed.title, 'Vehicle 7021', feedId);
    assert.doesNotMatch(JSON.stringify(keyed), /9011001000400000/, feedId);
  }
  // A feed the registry does not know names no line either.
  const unknown = hud(
    vehicle({ feedId: 'example-feed', routeId: '12', routeLabel: '12' }),
  );
  assert.equal(lineOf(unknown), null);
  assert.equal(unknown.title, 'Bus');

  inLocale(t, 'sv');
  assert.equal(hud(swedishTrain).title, 'Tåg 2861');
  assert.equal(
    cockpitSubjectCandidate(transitRide(transitLayer(swedishTrain)).candidate())
      .name,
    'Tåg 2861',
  );
});

test('a metro drawn at street level says so', (t) => {
  const signalsOf = (ride) => {
    enter(ride);
    return cockpitSubjectHudView(hudOf(ride)).signals;
  };
  const street = {
    id: 'street-level',
    title: 'SUBWAY',
    detail: 'Shown at street level · depth not in the feed',
    tone: 'estimate',
  };
  assert.deepEqual(
    signalsOf(transitRide(transitLayer(vehicle({ mode: 'subway' })))),
    [street],
  );
  assert.deepEqual(signalsOf(railRide(railLayer(train({ mode: 'metro' })))), [
    street,
  ]);
  assert.deepEqual(signalsOf(transitRide()), [], 'a bus is where it is');
  assert.deepEqual(signalsOf(railRide()), [], 'so is a train');

  inLocale(t, 'sv');
  const [swedish] = signalsOf(
    transitRide(transitLayer(vehicle({ mode: 'subway' }))),
  );
  assert.equal(swedish.title, 'TUNNELBANA');
  assert.equal(swedish.detail, 'Visas på gatunivå · djup saknas i flödet');
});

test('every feed’s credit and licence fit the rows the Cockpit shows', (t) => {
  for (const feed of [...TRANSIT_FEED_REGISTRY, ...RAIL_FEED_REGISTRY]) {
    const ride = transitRide(
      transitLayer(
        vehicle({
          feed: {
            id: feed.id,
            name: feed.name,
            operator: feed.operator,
            attribution: feed.attribution,
            license: feed.license,
          },
        }),
      ),
    );
    enter(ride);
    const rows = hudOf(ride).sources;
    assert.ok(rows.length >= 1 && rows.length <= 2, feed.id);
    // Nothing cut: each row as the feed gives it.
    assert.deepEqual(
      cockpitSubjectHudView({ sources: rows }).sources.map(({ text }) => text),
      rows.map(({ text }) => text),
      feed.id,
    );
  }
  inLocale(t, 'sv');
  const ride = transitRide(
    transitLayer(
      vehicle({ feed: { name: 'X', attribution: 'X', license: 'CC BY 4.0' } }),
    ),
  );
  enter(ride);
  assert.deepEqual(
    hudOf(ride).sources.map(({ label }) => label),
    ['KÄLLA', 'LICENS'],
  );
});

test('a HUD view that fails to build is worded again, never the last one kept', () => {
  const layer = transitLayer();
  const ride = transitRide(layer);
  const frame = enter(ride);
  const first = ride.hud(frame, CONTEXT);
  assert.ok(first);
  layer.state.held = vehicle({
    feed: {
      get name() {
        throw new Error('unreadable feed');
      },
    },
  });
  ride.read(0, CONTEXT);
  assert.equal(ride.hud(frame, CONTEXT), null);
  assert.equal(ride.hud(frame, CONTEXT), null, 'not the view before');
  layer.state.held = vehicle();
  ride.read(0, CONTEXT);
  assert.deepEqual(ride.hud(frame, CONTEXT), first);
});

test('a train’s destination shows once Rail names it', () => {
  const layer = railLayer();
  layer.state.name = 'Tåg 2861';
  const ride = railRide(layer);
  const frame = enter(ride);
  const before = ride.hud(frame, CONTEXT);
  assert.equal(before.title, 'Tåg 2861');
  assert.equal(ride.hud(frame, CONTEXT), before, 'unchanged meanwhile');
  layer.state.name = 'Tåg 2861 mot Stockholm C';
  const after = ride.hud(frame, CONTEXT);
  assert.notEqual(after, before);
  assert.equal(after.title, 'Tåg 2861 mot Stockholm C');
  assert.equal(ride.read(0, CONTEXT).name, 'Tåg 2861 mot Stockholm C');
});

test('a train on its line with no direction faces along it; a line with no bearing leaves its course', () => {
  const coords = [];
  for (let d = 0; d <= 6000; d += 100)
    coords.push(
      42.36,
      -71.08 + d / (111_320 * Math.cos((42.36 * Math.PI) / 180)),
    );
  const ridden = (path, courseDeg = 10) =>
    enter(
      railRide(
        railLayer(
          train({
            key: 'rail:mbta-rail:T1',
            position: { latitude: 0, longitude: 0 },
            motion: { courseDeg },
            path: Object.freeze(path),
          }),
        ),
      ),
    );
  // Neither playback nor a bearing has told the way yet: along the line, as
  // docs/APPLICATION.md turns it only for a direction below 0.
  const untold = ridden({
    s: 1234,
    direction: 0,
    line: createRailPath(coords),
  });
  assert.ok(Math.abs(untold.headingDeg - 90) < 1e-6);
  // A line that stays in one place has no bearing: the drawn course.
  const still = ridden(
    { s: 0, direction: 1, line: createRailPath([59.6, 16.5, 59.6, 16.5]) },
    123,
  );
  assert.equal(still.headingDeg, 123);
  assert.equal(still.latitude, 59.6);
});
