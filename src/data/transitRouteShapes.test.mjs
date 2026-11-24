// Swedish fork: the route-shape format and the rules that decide whether a
// Trafiklab vehicle is drawn along its trip's shape between two reports
// (transitRouteShapes.js), on an L-shaped street and its counterexamples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailPath } from './railPaths.js';
import {
  ROUTE_SHAPE_ID_PATTERN,
  ROUTE_SHAPE_MAX_OFFSET_M,
  decodeRouteShape,
  encodeRouteShape,
  followRouteShape,
  initRouteShapeFrame,
  routeShapeBetween,
  sampleRouteShapePosition,
} from './transitRouteShapes.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { displacementPlausible } from '../layers/transit/movement.js';

const M_PER_DEG = 111_320;
/** Metres between two lat/lon points, flat-earth. */
const metres = (a, b) =>
  Math.hypot(
    (b.lat - a.lat) * M_PER_DEG,
    (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180),
  );

// A street that runs north for 1.1 km, turns at the corner and runs east.
const CORNER = { lat: 59.31, lon: 18.0 };
const L_STREET = createRailPath([59.3, 18.0, 59.31, 18.0, 59.31, 18.02]);
// A bus 6 m east of the northbound leg, then 11 m north of the eastbound one.
const BEFORE = { t: 0, lat: 59.305, lon: 18.0001 };
const AFTER = { t: 100_000, lat: 59.3101, lon: 18.01 };
const bus = (metresAlong, seconds) =>
  displacementPlausible('bus', metresAlong, seconds);

test('a polyline is Google’s format at five decimals, and reads back', () => {
  // The format's own worked example.
  assert.equal(
    encodeRouteShape([38.5, -120.2, 40.7, -120.95, 43.252, -126.453]),
    '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  );
  assert.deepEqual(
    decodeRouteShape('_p~iF~ps|U_ulLnnqC_mqNvxq`@'),
    [38.5, -120.2, 40.7, -120.95, 43.252, -126.453],
  );
  const coords = [59.312341, 18.061231, 59.312342, 18.061232, 59.32, 18.07];
  // Rounded to five decimals; a point rounding onto the one before is left out.
  assert.deepEqual(
    decodeRouteShape(encodeRouteShape(coords)),
    [59.31234, 18.06123, 59.32, 18.07],
  );
  assert.equal(encodeRouteShape([59.3, 18]), '', 'one point is no line');
  assert.equal(encodeRouteShape([91, 18, 59, 18]), '', 'off the globe');
});

test('a polyline that is not one, or has too many points, reads as none', () => {
  assert.equal(decodeRouteShape(''), null);
  assert.equal(decodeRouteShape(null), null);
  assert.equal(decodeRouteShape('_p~iF'), null, 'a point without a longitude');
  assert.equal(decodeRouteShape('_p~iF~ps|U'), null, 'a single point');
  assert.equal(decodeRouteShape('_p~iF~ps|U\n_ulLnnqC'), null, 'a stray byte');
  assert.equal(decodeRouteShape('____________'), null, 'a value never ending');
  const long = encodeRouteShape(
    Array.from({ length: 20 }, (_, i) => [59 + i / 1000, 18]).flat(),
  );
  assert.equal(decodeRouteShape(long, 19), null);
  assert.equal(decodeRouteShape(long, 20).length, 40);
});

test('shape ids are printable ASCII without the comma that separates them', () => {
  assert.ok(ROUTE_SHAPE_ID_PATTERN.test('1014010000496563155'));
  assert.ok(ROUTE_SHAPE_ID_PATTERN.test('SL:shape/7_a'));
  assert.ok(!ROUTE_SHAPE_ID_PATTERN.test('a,b'));
  assert.ok(!ROUTE_SHAPE_ID_PATTERN.test('a b'));
  assert.ok(!ROUTE_SHAPE_ID_PATTERN.test('å'));
  assert.ok(!ROUTE_SHAPE_ID_PATTERN.test('x'.repeat(65)));
});

test('a bus on an L-shaped street turns the corner between its reports', () => {
  const along = routeShapeBetween(L_STREET, BEFORE, AFTER, { plausible: bus });
  assert.ok(along, 'the reports lie on the street');
  const m = along.lat.length - 1;
  // Starts and ends on the reports themselves, never past the later one.
  assert.deepEqual([along.lat[0], along.lon[0]], [BEFORE.lat, BEFORE.lon]);
  assert.deepEqual([along.lat[m], along.lon[m]], [AFTER.lat, AFTER.lon]);
  assert.equal(along.fractions[0], 0);
  assert.equal(along.fractions[m], 1);
  for (let k = 1; k <= m; k++)
    assert.ok(along.fractions[k] > along.fractions[k - 1], 'in order');
  // Steps of 25 m at most, along a way 1.41 times the straight one.
  const arc = along.sB - along.sA;
  const straight = metres(BEFORE, AFTER);
  assert.ok(arc / straight > 1.35 && arc / straight < 1.45, `${arc}`);
  for (let k = 1; k <= m; k++)
    assert.ok(
      metres(
        { lat: along.lat[k - 1], lon: along.lon[k - 1] },
        { lat: along.lat[k], lon: along.lon[k] },
      ) <= 25.5,
    );
  // The corner is a point of the path (moved by the reports' offsets, a
  // few metres), where a straight line would pass hundreds of metres off.
  const nearest = Math.min(
    ...Array.from(along.lat, (lat, k) =>
      metres(CORNER, { lat, lon: along.lon[k] }),
    ),
  );
  assert.ok(nearest < 12, `nearest point ${nearest} m from the corner`);
  // North before the corner, east after it.
  assert.ok(along.courses[0] < 2 || along.courses[0] > 358, along.courses[0]);
  assert.ok(Math.abs(along.courses[m - 1] - 90) < 2, along.courses[m - 1]);
  // Its speed is the way along the street in the time between the reports.
  assert.ok(Math.abs(along.speedMps - arc / 100) < 1e-9);
});

test('a report off the shape is a detour: straight lines', () => {
  const off = { ...AFTER, lat: 59.311 }; // 100 m north of the street
  assert.ok(
    metres(off, { lat: 59.31, lon: off.lon }) > ROUTE_SHAPE_MAX_OFFSET_M,
  );
  assert.equal(routeShapeBetween(L_STREET, BEFORE, off), null);
  assert.equal(
    routeShapeBetween(L_STREET, { ...BEFORE, lon: 18.002 }, AFTER),
    null,
    'the earlier one off it too',
  );
});

test('a way back along the shape draws straight lines', () => {
  assert.equal(
    routeShapeBetween(
      L_STREET,
      { ...AFTER, t: 0 },
      { ...BEFORE, t: 100_000 },
      { plausible: bus },
    ),
    null,
  );
});

test('a way along the shape much longer than the straight one draws straight lines', () => {
  // Up one side of a block and down the other: five times the straight way.
  const block = createRailPath([
    59.3, 18.0, 59.31, 18.0, 59.31, 18.01, 59.3, 18.01,
  ]);
  assert.equal(
    routeShapeBetween(
      block,
      { t: 0, lat: 59.3, lon: 18.0001 },
      { t: 300_000, lat: 59.3, lon: 18.0099 },
    ),
    null,
  );
});

test('on a loop’s way back, the shortest way is taken, never the loop again', () => {
  // North up a street on its west lane, round a block, and back south on
  // the east lane 2.3 m away. The bus is on the way back just after the
  // loop, its earlier report 1 m east of the west lane (GPS noise).
  const W = 18.0;
  const E = 18.00004;
  const lollipop = createRailPath([
    59.3,
    W,
    59.309,
    W,
    59.3097,
    W,
    59.3097,
    18.0008,
    59.309,
    18.0008,
    59.309,
    E,
    59.3,
    E,
  ]);
  const a = { t: 0, lat: 59.3089, lon: 18.00001 };
  const b = { t: 20_000, lat: 59.307, lon: E };
  const along = routeShapeBetween(lollipop, a, b, { plausible: bus });
  assert.ok(along, 'along the way back');
  assert.ok(
    along.sB - along.sA < metres(a, b) + 10,
    `${along.sB - along.sA} m along, ${metres(a, b)} m straight`,
  );
  assert.ok(Math.max(...along.lat) < 59.30902, 'not round the block');
});

test('another pass much farther from a report than the nearest is not where it is', () => {
  // Up a street, a U-turn 28 m across, and back down the other side. 20 m
  // before the U-turn and 3 m off the way up, the bus is 25 m from the way
  // down too; 15 s later it is on the way down. It went round the U-turn.
  const W = 18.0;
  const E = 18.0005;
  const uTurn = createRailPath([59.3, W, 59.306, W, 59.306, E, 59.3, E]);
  const a = { t: 0, lat: 59.3058, lon: W + 0.00005 };
  const b = { t: 15_000, lat: 59.3045, lon: E };
  const along = routeShapeBetween(uTurn, a, b, { plausible: bus });
  assert.ok(along);
  assert.ok(Math.max(...along.lat) > 59.30595, 'round the U-turn');
  assert.ok(along.sB - along.sA > 190, `${along.sB - along.sA} m along`);
});

test('a way along the shape too fast for the mode draws straight lines', () => {
  assert.equal(
    routeShapeBetween(
      L_STREET,
      BEFORE,
      { ...AFTER, t: 10_000 },
      {
        plausible: bus,
      },
    ),
    null,
  );
});

test('a standing vehicle, or one with no time between reports, is not shaped', () => {
  assert.equal(
    routeShapeBetween(L_STREET, BEFORE, { ...BEFORE, t: 15_000 }),
    null,
  );
  assert.equal(routeShapeBetween(L_STREET, BEFORE, { ...AFTER, t: 0 }), null);
});

test('little room keeps the shape’s own corners, and too little none', () => {
  const corners = routeShapeBetween(L_STREET, BEFORE, AFTER, { maxSteps: 3 });
  assert.equal(corners.lat.length, 3, 'the two reports and the corner');
  assert.ok(metres(CORNER, { lat: corners.lat[1], lon: corners.lon[1] }) < 12);
  assert.equal(
    routeShapeBetween(L_STREET, BEFORE, AFTER, { maxSteps: 1 }),
    null,
  );
});

test('two reports on one straight edge of the shape glide as a straight line does', () => {
  const along = routeShapeBetween(
    L_STREET,
    { t: 0, lat: 59.302, lon: 18.0 },
    { t: 30_000, lat: 59.304, lon: 18.0 },
    { plausible: bus },
  );
  assert.ok(along);
  const m = along.lat.length - 1;
  for (let k = 0; k <= m; k++) {
    assert.ok(
      Math.abs(along.lat[k] - (59.302 + 0.002 * along.fractions[k])) < 1e-9,
    );
    assert.ok(Math.abs(along.lon[k] - 18) < 1e-12);
  }
});

/** A display path for `along` as trails.js builds it, on a flat floor. */
function displayPath(along, toSeq = 1) {
  return {
    positions: Array.from(along.lat, (lat, k) =>
      fromDegrees(along.lon[k], lat, 20),
    ),
    toSeq,
    shape: along,
    cursor: 0,
  };
}

/**
 * A vehicle as transit movement keeps it, its sample where playback put it
 * on the segment between reports `fromSeq` and `toSeq` (`a`, `b`): the
 * straight speed and course playback works out, `chordCourse`.
 */
function vehicleOn(displayPaths) {
  const entry = {
    sample: {},
    displayPaths,
    track: { policy: { courseMinTravelM: 12 } },
  };
  initRouteShapeFrame(entry);
  return entry;
}
function playAt(entry, { fromSeq, toSeq, a, b, fraction, chordCourse }) {
  const sample = entry.sample;
  const moving = fromSeq !== toSeq;
  sample.fromSeq = fromSeq;
  sample.toSeq = toSeq;
  sample.fromT = a.t;
  sample.toT = moving ? b.t : a.t;
  sample.fraction = moving ? fraction : 1;
  sample.lat = moving ? a.lat + (b.lat - a.lat) * fraction : a.lat;
  sample.lon = moving ? a.lon + (b.lon - a.lon) * fraction : a.lon;
  sample.segmentSpeedMps = moving ? (metres(a, b) * 1000) / (b.t - a.t) : 0;
  sample.segmentCourseDeg = chordCourse;
  return followRouteShape(entry);
}

test('per frame, a shaped path places, turns and moves the sample along it', () => {
  const along = routeShapeBetween(L_STREET, BEFORE, AFTER, { plausible: bus });
  const path = displayPath(along);
  const entry = vehicleOn(new Map([[0, path]]));
  const sample = entry.sample;
  const out = { x: 0, y: 0, z: 0 };
  // Where the way along reaches the corner, in time.
  const atCorner = (L_STREET.s[1] - along.sA) / (along.sB - along.sA);
  for (const fraction of [0, 0.25, atCorner, 0.75, 1, atCorner, 0.1]) {
    assert.equal(
      playAt(entry, {
        fromSeq: 0,
        toSeq: 1,
        a: BEFORE,
        b: AFTER,
        fraction,
        chordCourse: 45,
      }),
      true,
    );
    assert.equal(entry.routeShapeDrawn, true);
    const k = along.fractions.findLastIndex((f) => f <= fraction);
    const i = Math.min(k, along.fractions.length - 2);
    const t =
      (fraction - along.fractions[i]) /
      (along.fractions[i + 1] - along.fractions[i]);
    const lat = along.lat[i] + (along.lat[i + 1] - along.lat[i]) * t;
    assert.ok(Math.abs(sample.lat - lat) < 1e-12, `${fraction}`);
    assert.equal(sample.segmentCourseDeg, along.courses[i]);
    assert.equal(sample.segmentSpeedMps, along.speedMps);
    const drawn = sampleRouteShapePosition(path, sample, out);
    assert.equal(drawn, out);
    const expected = fromDegrees(sample.lon, sample.lat, 20);
    assert.ok(
      Math.hypot(out.x - expected.x, out.y - expected.y, out.z - expected.z) <
        0.05,
      `${fraction}`,
    );
  }
  playAt(entry, {
    fromSeq: 0,
    toSeq: 1,
    a: BEFORE,
    b: AFTER,
    fraction: atCorner,
    chordCourse: 45,
  });
  assert.ok(metres(CORNER, sample) < 12, 'at the corner when the way says');
});

test('the course is the shape’s own direction, north up the street and east after the corner', () => {
  const along = routeShapeBetween(L_STREET, BEFORE, AFTER, { plausible: bus });
  const m = along.lat.length - 1;
  const corner = along.fractions.findIndex(
    (_, k) => metres(CORNER, { lat: along.lat[k], lon: along.lon[k] }) < 12,
  );
  for (let k = 0; k < m; k++)
    assert.equal(along.courses[k], k < corner ? 0 : 90, `step ${k}`);
  assert.equal(along.courses[m], 90, 'the way it arrives');
});

test('standing where it arrived along the shape, a vehicle faces the way it came and is still along it', () => {
  // Up the street and round the corner, then a stop at the next report,
  // creeping 3 m, then 200 m on in a straight line (no shaped path).
  const along = routeShapeBetween(L_STREET, BEFORE, AFTER, { plausible: bus });
  const entry = vehicleOn(new Map([[0, displayPath(along)]]));
  const STOP = { ...AFTER, t: AFTER.t + 30_000 };
  const CREEP = {
    t: STOP.t + 20_000,
    lat: AFTER.lat,
    lon: AFTER.lon + 0.00005,
  };
  const ON = { t: CREEP.t + 20_000, lat: AFTER.lat, lon: AFTER.lon + 0.0036 };
  // Playback holds the last long chord's course: the corner cut, 45° here.
  const held = 45;
  // Each segment for two frames, as the frame pass plays it.
  for (const [what, play, course, drawn] of [
    [
      'round the corner',
      { fromSeq: 0, toSeq: 1, a: BEFORE, b: AFTER },
      90,
      true,
    ],
    ['held at the report', { fromSeq: 1, toSeq: 1, a: AFTER }, 90, true],
    [
      'two reports at one place',
      { fromSeq: 1, toSeq: 2, a: AFTER, b: STOP },
      90,
      true,
    ],
    ['a creep of 3 m', { fromSeq: 2, toSeq: 3, a: STOP, b: CREEP }, 90, true],
    [
      'on in a straight line',
      { fromSeq: 3, toSeq: 4, a: CREEP, b: ON },
      held,
      false,
    ],
    ['standing after it', { fromSeq: 4, toSeq: 4, a: ON }, held, false],
  ])
    // Past the corner, at 49 % of the way round.
    for (const fraction of [0.8, 0.95]) {
      playAt(entry, { ...play, fraction, chordCourse: held });
      assert.equal(
        entry.sample.segmentCourseDeg,
        course,
        `${what} ${fraction}`,
      );
      assert.equal(entry.routeShapeDrawn, drawn, `${what} ${fraction}`);
    }
});

test('a short shaped segment gives no course of its own', () => {
  // 3 m of jitter at a stop along a straight street, after a straight
  // arrival: playback's held course stands, not the jitter's.
  const street = createRailPath([59.3, 18.0, 59.32, 18.0]);
  const a = { t: 0, lat: 59.30135, lon: 18.0 };
  const b = { t: 5_000, lat: 59.301355, lon: 18.000053 };
  const along = routeShapeBetween(street, a, b, { plausible: bus });
  assert.ok(along, 'the jitter lies on the street');
  const entry = vehicleOn(new Map([[0, displayPath(along)]]));
  playAt(entry, { fromSeq: 0, toSeq: 1, a, b, fraction: 0.5, chordCourse: 0 });
  assert.equal(entry.sample.segmentCourseDeg, 0);
});

test('a segment’s path is looked up once, not on every frame', () => {
  const along = routeShapeBetween(L_STREET, BEFORE, AFTER, { plausible: bus });
  let gets = 0;
  const paths = new (class extends Map {
    get(key) {
      gets += 1;
      return super.get(key);
    }
  })([[0, displayPath(along)]]);
  const entry = vehicleOn(paths);
  for (let f = 0; f < 1; f += 0.1)
    playAt(entry, {
      fromSeq: 0,
      toSeq: 1,
      a: BEFORE,
      b: AFTER,
      fraction: f,
      chordCourse: 45,
    });
  assert.equal(gets, 1);
  // A preparation of the paths forgets it (routeShapes.js end()).
  entry.routeShapeAt = -1;
  playAt(entry, {
    fromSeq: 0,
    toSeq: 1,
    a: BEFORE,
    b: AFTER,
    fraction: 0.5,
    chordCourse: 45,
  });
  assert.equal(gets, 2);
});
