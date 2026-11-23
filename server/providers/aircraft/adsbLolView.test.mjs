// Swedish fork: the whole view's discs from adsb.lol (adsbLolView.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADSBLOL_DISC_KM,
  ADSBLOL_VIEW_MAX_AIRCRAFT,
  ADSBLOL_VIEW_MAX_DISCS,
  ADSBLOL_VIEW_MAX_KM,
  adsbLolOuterDiscs,
  adsbLolViewPlan,
  coveredShare,
  greatCircleKm,
  latticeDiscsNear,
  latticeStepDeg,
  mergeAdsbLolDiscs,
  reachesWholeExtent,
} from './adsbLolView.js';
import { clipViewExtent } from '../../../src/geo/viewExtent.js';

/** The look-at point's own 0.25° cell, the centre disc's anchor. */
const cell = ({ latitude, longitude }) => ({
  latitude: Math.round(latitude * 4) / 4,
  longitude: Math.round(longitude * 4) / 4,
});
const plan = (lookAt, rect) =>
  adsbLolOuterDiscs(
    lookAt,
    clipViewExtent(rect, lookAt, ADSBLOL_VIEW_MAX_KM),
    cell(lookAt),
  );
const SWEDEN = { latitude: 62, longitude: 16 };
const WHOLE_SWEDEN = { west: 4, south: 54, east: 30, north: 70 };

test('the lattice: rows every 5°, centres about 5° of latitude apart, keys as the flights route keys a disc', () => {
  assert.equal(latticeStepDeg(0), 5);
  assert.equal(latticeStepDeg(60), 10);
  assert.ok(Math.abs(latticeStepDeg(55) - 360 / 42) < 1e-9);
  assert.equal(latticeStepDeg(85), 360 / 7);
  const near = latticeDiscsNear(SWEDEN, 700);
  assert.ok(near.some((disc) => disc.key === '60.00,20.00'));
  assert.ok(near.some((disc) => disc.key === '65.00,11.61'));
  for (const disc of near) {
    assert.equal(disc.latitude % 5, 0, disc.key);
    assert.match(disc.key, /^-?\d+\.\d{2},-?\d+\.\d{2}$/);
    assert.ok(disc.km <= 700);
  }
  // The same disc for every view: a key never depends on where it is seen from.
  const elsewhere = latticeDiscsNear({ latitude: 58, longitude: 22 }, 700);
  const shared = elsewhere.find((disc) => disc.key === '60.00,20.00');
  assert.deepEqual(
    { latitude: shared.latitude, longitude: shared.longitude },
    { latitude: 60, longitude: 20 },
  );
  // No point up to 85° lies beyond a disc's reach of a centre.
  for (let latitude = -84; latitude <= 84; latitude += 7.3)
    for (let longitude = -180; longitude < 180; longitude += 11.7) {
      const nearest = Math.min(
        ...latticeDiscsNear({ latitude, longitude }, 900).map((d) => d.km),
      );
      assert.ok(nearest < ADSBLOL_DISC_KM, `${latitude}, ${longitude}`);
    }
});

test('a view inside the centre disc needs no outer disc; a wider one the nearest that add a tenth of a disc, five at most', () => {
  // Stockholm, and southern Sweden: the centre disc covers them.
  assert.deepEqual(
    plan(
      { latitude: 59.33, longitude: 18.07 },
      { west: 17.5, south: 59, east: 18.6, north: 59.6 },
    ),
    [],
  );
  assert.deepEqual(
    plan(
      { latitude: 57.5, longitude: 14.5 },
      { west: 9, south: 54.5, east: 20, north: 60.5 },
    ),
    [],
  );
  const sweden = plan(SWEDEN, WHOLE_SWEDEN);
  assert.equal(sweden.length, ADSBLOL_VIEW_MAX_DISCS - 1);
  assert.deepEqual(
    sweden.map((disc) => disc.key),
    ['60.00,20.00', '60.00,10.00', '65.00,11.61', '65.00,23.23', '55.00,17.14'],
  );
  for (let i = 1; i < sweden.length; i++)
    assert.ok(sweden[i].km >= sweden[i - 1].km, 'nearest first');
  // The whole of Europe: still five, the nearest the look-at point.
  const europe = plan(
    { latitude: 50, longitude: 10 },
    { west: -15, south: 35, east: 35, north: 65 },
  );
  assert.equal(europe.length, 5);
  assert.ok(europe.every((disc) => disc.km < 700));
});

test('a view across the antimeridian is covered on both sides of it', () => {
  const fiji = plan(
    { latitude: -17, longitude: 179 },
    { west: 170, south: -25, east: -170, north: -10 },
  );
  assert.ok(fiji.length > 0);
  assert.ok(fiji.some((disc) => disc.longitude < 0));
  assert.ok(fiji.some((disc) => disc.longitude > 0));
  for (const disc of fiji)
    assert.ok(disc.longitude >= -180 && disc.longitude < 180);
});

test('how much of a view the discs shown cover, judged on the plan’s own points', () => {
  const sweden = clipViewExtent(WHOLE_SWEDEN, SWEDEN, ADSBLOL_VIEW_MAX_KM);
  const { discs, points } = adsbLolViewPlan(SWEDEN, sweden, cell(SWEDEN));
  const alone = coveredShare(points, [cell(SWEDEN)]);
  const all = coveredShare(points, [cell(SWEDEN), ...discs]);
  assert.ok(alone.share > 0.2 && alone.share < 0.35, String(alone.share));
  assert.ok(all.share > 0.75 && all.share < 0.9, String(all.share));
  assert.ok(all.uncovered > 0, 'the whole of Sweden is not covered');
  const city = { latitude: 59.33, longitude: 18.07 };
  const stockholm = adsbLolViewPlan(
    city,
    { west: 17.5, south: 59, east: 18.6, north: 59.6 },
    cell(city),
  );
  assert.deepEqual(stockholm.discs, []);
  assert.deepEqual(coveredShare(stockholm.points, [cell(city)]), {
    share: 1,
    uncovered: 0,
  });
});

test('a view is whole only when its discs reach every point of it, between the plan’s points too, by their reach less a margin', () => {
  // Mid-Sweden: the centre disc and two outer discs reach all of it.
  const middle = clipViewExtent(
    { west: 10, south: 57, east: 22, north: 63 },
    SWEDEN,
    ADSBLOL_VIEW_MAX_KM,
  );
  const { discs } = adsbLolViewPlan(SWEDEN, middle, cell(SWEDEN));
  assert.deepEqual(
    discs.map((disc) => disc.key),
    ['60.00,20.00', '60.00,10.00'],
  );
  assert.equal(reachesWholeExtent(middle, [cell(SWEDEN), ...discs]), true);
  assert.equal(reachesWholeExtent(middle, [cell(SWEDEN), discs[0]]), false);
  // North of Norway every plan point is reached, but not a sliver between.
  const north = { latitude: 69.46, longitude: 19.28 };
  const arctic = clipViewExtent(
    { west: -0.36, south: 66.57, east: 31.35, north: 73.11 },
    north,
    ADSBLOL_VIEW_MAX_KM,
  );
  const far = adsbLolViewPlan(north, arctic, cell(north));
  const anchors = [cell(north), ...far.discs];
  assert.equal(coveredShare(far.points, anchors).uncovered, 0);
  assert.equal(reachesWholeExtent(arctic, anchors), false);
  // Across the antimeridian: by the disc on it, not by one 10° off.
  const date = { west: 179, south: 59.5, east: -179, north: 60.5 };
  assert.equal(
    reachesWholeExtent(date, [{ latitude: 60, longitude: -180 }]),
    true,
  );
  assert.equal(
    reachesWholeExtent(date, [{ latitude: 60, longitude: 170 }]),
    false,
  );
  // A corner within a disc's reach, but not 10 km inside it, is not whole.
  const anchor = { latitude: 60, longitude: 18 };
  const edge = { west: 17.99, south: 64.05, east: 18.01, north: 64.11 };
  const corner = { latitude: 64.11, longitude: 18.01 };
  assert.ok(greatCircleKm(anchor, corner) < ADSBLOL_DISC_KM);
  assert.ok(greatCircleKm(anchor, corner) > ADSBLOL_DISC_KM - 10);
  assert.equal(reachesWholeExtent(edge, [anchor]), false);
  assert.equal(
    reachesWholeExtent({ ...edge, south: 63.9, north: 63.95 }, [anchor]),
    true,
  );
});

/** A state vector: hex, position time (epoch s), longitude, latitude. */
const state = (hex, at, lon = 18, lat = 59) => {
  const row = Array(18).fill(null);
  row[0] = hex;
  row[3] = at;
  row[5] = lon;
  row[6] = lat;
  return row;
};
const NOW_S = 1_800_000_000;
const CENTRE_ANCHOR = { latitude: 59.25, longitude: 18 };
const OUTER_ANCHOR = { latitude: 60, longitude: 20 };

test('the merge keeps each aircraft once, from the disc with its freshest position, with that disc’s status and type', () => {
  const centre = {
    payload: {
      time: NOW_S,
      states: [state('aaa111', NOW_S - 5), state('bbb222', NOW_S - 50)],
      emergencyByIcao: { aaa111: 'none', bbb222: 'general' },
      typeByIcao: { aaa111: 'A320', bbb222: 'B738' },
    },
    hidden: ['ddd444'],
    anchor: CENTRE_ANCHOR,
    centre: true,
  };
  const outer = {
    payload: {
      time: NOW_S - 300,
      states: [
        state('aaa111', NOW_S - 300),
        state('bbb222', NOW_S - 10),
        state('ccc333', NOW_S - 300, 25, 65),
        // A later duplicate within one disc is not the one admitted.
        state('ccc333', NOW_S - 1, 25, 65),
      ],
      emergencyByIcao: { bbb222: 'none' },
      typeByIcao: { bbb222: 'B739', ccc333: 'AT76' },
    },
    hidden: ['ddd444', 'eee555'],
    anchor: OUTER_ANCHOR,
  };
  const { payload, count, seen, gone, privacyHidden } = mergeAdsbLolDiscs(
    [centre, outer],
    { latitude: 59, longitude: 18 },
    { notBeforeS: NOW_S - 1800, agedBeforeS: NOW_S - 100 },
  );
  assert.equal(payload.time, NOW_S, 'the centre’s time');
  assert.equal(count, 3);
  assert.equal(seen, 3);
  assert.equal(gone, 0);
  const byHex = Object.fromEntries(payload.states.map((row) => [row[0], row]));
  assert.equal(byHex.aaa111[3], NOW_S - 5, 'the centre’s fresher position');
  assert.equal(byHex.bbb222[3], NOW_S - 10, 'the outer disc’s fresher one');
  assert.equal(byHex.ccc333[3], NOW_S - 300, 'the first row of its disc');
  assert.deepEqual(payload.emergencyByIcao, { aaa111: 'none', bbb222: 'none' });
  assert.deepEqual(payload.typeByIcao, {
    aaa111: 'A320',
    bbb222: 'B739',
    ccc333: 'AT76',
  });
  // Aged by its age, whichever disc it came from.
  assert.deepEqual(payload.agedByIcao, ['ccc333']);
  assert.equal(privacyHidden, 2, 'hidden aircraft counted once each');
});

test('another disc’s aircraft than the centre’s is kept only with a position of known age within the cap; the centre’s as they come', () => {
  const old = NOW_S - 1801;
  const discs = [
    {
      payload: { time: NOW_S, states: [state('aaa111', old)] },
      anchor: CENTRE_ANCHOR,
      centre: true,
    },
    {
      payload: {
        time: NOW_S,
        states: [
          state('bbb222', old, 25, 65),
          state('ccc333', null, 25, 65),
          state('ddd444', NOW_S - 1800, 25, 65),
        ],
      },
      anchor: { latitude: 65, longitude: 23.23 },
    },
  ];
  const { payload } = mergeAdsbLolDiscs(discs, SWEDEN, {
    notBeforeS: NOW_S - 1800,
    agedBeforeS: NOW_S - 600,
  });
  assert.deepEqual(payload.states.map((row) => row[0]).sort(), [
    'aaa111',
    'ddd444',
  ]);
  assert.deepEqual(payload.agedByIcao.sort(), ['aaa111', 'ddd444']);
  assert.equal('emergencyByIcao' in payload, false);
  assert.equal('typeByIcao' in payload, false);
});

test('an older disc’s aircraft deep inside a fresher disc that does not list it is gone; near that disc’s edge, or listed, it stays', () => {
  // The fresher disc, read 10 min after the older one, around 60° N 18° E.
  const fresher = {
    payload: { time: NOW_S, states: [state('kept01', NOW_S - 2, 18, 60)] },
    anchor: { latitude: 60, longitude: 18 },
    centre: true,
  };
  const older = {
    payload: {
      time: NOW_S - 600,
      states: [
        // 28 km from the fresher disc's centre: it cannot have left it.
        state('gone01', NOW_S - 600, 18.5, 60),
        // 389 km out: 10 min at 680 kt could take it past the edge.
        state('edge01', NOW_S - 600, 25, 60),
        // Beyond the fresher disc's reach.
        state('far001', NOW_S - 600, 30, 60),
        state('kept01', NOW_S - 600, 18.2, 60),
      ],
    },
    anchor: { latitude: 60, longitude: 24 },
  };
  const { payload, gone } = mergeAdsbLolDiscs(
    [fresher, older],
    { latitude: 60, longitude: 18 },
    { notBeforeS: NOW_S - 1800, agedBeforeS: NOW_S - 500 },
  );
  assert.equal(gone, 1);
  assert.deepEqual(payload.states.map((row) => row[0]).sort(), [
    'edge01',
    'far001',
    'kept01',
  ]);
  const kept = payload.states.find((row) => row[0] === 'kept01');
  assert.equal(kept[3], NOW_S - 2, 'the fresher disc’s word');
});

test('past the most aircraft an answer gives, those nearest the look-at point are kept', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    state(`a${String(i).padStart(5, '0')}`, NOW_S, 18 + i * 0.1, 59),
  );
  const { payload, count, seen } = mergeAdsbLolDiscs(
    [
      {
        payload: { time: NOW_S, states: rows.reverse() },
        anchor: { latitude: 59, longitude: 19.5 },
        centre: true,
      },
    ],
    { latitude: 59, longitude: 18 },
    { notBeforeS: NOW_S - 1800, agedBeforeS: NOW_S - 500, maxAircraft: 10 },
  );
  assert.equal(count, 10);
  assert.equal(seen, 30);
  assert.deepEqual(
    payload.states.map((row) => row[0]),
    Array.from({ length: 10 }, (_, i) => `a${String(i).padStart(5, '0')}`),
  );
  assert.equal(ADSBLOL_VIEW_MAX_AIRCRAFT, 2000);
});

test('great-circle distances take the short way round', () => {
  assert.ok(
    Math.abs(
      greatCircleKm(
        { latitude: 0, longitude: 179.5 },
        { latitude: 0, longitude: -179.5 },
      ) - 111.19,
    ) < 0.1,
  );
});
