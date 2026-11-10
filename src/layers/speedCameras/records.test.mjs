// Trafikverket's camera sites: parsing, compass points and nearness.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  camerasNear,
  compassIndex,
  COMPASS,
  normalizeSpeedCamera,
  normalizeSpeedCameras,
  unreadCountyNumbers,
} from './records.js';

const row = (over = {}) => ({
  Id: 'TSC1',
  Name: 'Rotebro',
  RoadNumber: 'E4',
  Bearing: 182,
  CountyNo: [1],
  Geometry: { WGS84: 'POINT (17.9123456 59.4712345)' },
  Deleted: false,
  ...over,
});

test('a site keeps its road, direction, county and a rounded point', () => {
  assert.deepEqual(normalizeSpeedCamera(row()), {
    id: 'TSC1',
    name: 'Rotebro',
    road: 'E4',
    bearing: 182,
    county: 'Stockholms län',
    point: [17.91235, 59.47123],
  });
  assert.equal(normalizeSpeedCamera(row({ Bearing: -90 })).bearing, 270);
  assert.equal(normalizeSpeedCamera(row({ Bearing: null })).bearing, null);
  assert.equal(normalizeSpeedCamera(row({ RoadNumber: ' ' })).road, null);
  assert.equal(normalizeSpeedCamera(row({ Name: '' })).name, 'TSC1');
});

test('deleted, unplaced and foreign sites are dropped', () => {
  assert.equal(normalizeSpeedCamera(row({ Deleted: true })), null);
  assert.equal(normalizeSpeedCamera(row({ Geometry: {} })), null);
  assert.equal(
    normalizeSpeedCamera(row({ Geometry: { WGS84: 'POINT (2.35 48.85)' } })),
    null,
  );
  assert.equal(normalizeSpeedCamera(row({ Id: null })), null);
});

test('the answer is sorted by road number, then name', () => {
  const cameras = normalizeSpeedCameras({
    RESPONSE: {
      RESULT: [
        {
          TrafficSafetyCamera: [
            row({ Id: 'a', RoadNumber: 'E45', Name: 'B' }),
            row({ Id: 'b', RoadNumber: 'E4', Name: 'Ö' }),
            row({ Id: 'c', RoadNumber: 'E4', Name: 'A' }),
            row({ Id: 'd', Deleted: true }),
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['c', 'b', 'a'],
  );
  assert.throws(() => normalizeSpeedCameras({}), /Malformed/);
});

test('bearings map to the nearest of eight compass points', () => {
  assert.equal(COMPASS[compassIndex(0)], 'N');
  assert.equal(COMPASS[compassIndex(359)], 'N');
  assert.equal(COMPASS[compassIndex(90)], 'E');
  assert.equal(COMPASS[compassIndex(200)], 'S');
  assert.equal(COMPASS[compassIndex(-45)], 'NW');
});

test('nearby sites are nearest first, within the radius', () => {
  const at = (id, lon, lat) => ({ id, point: [lon, lat] });
  const near = camerasNear(
    [at('far', 18.5, 59.33), at('close', 18.07, 59.33), at('mid', 18.2, 59.33)],
    [18.06, 59.33],
    15,
  );
  assert.deepEqual(
    near.map((camera) => camera.id),
    ['close', 'mid'],
  );
  assert.ok(near[0].km < 1 && near[1].km > 7);
});

const answerOf = (rows) => ({
  RESPONSE: { RESULT: [{ TrafficSafetyCamera: rows }] },
});

test('a coordinate that is no number is no site', () => {
  for (const point of [
    'POINT (- 59.47)',
    'POINT (1.2.3 59.47)',
    'POINT (17.9 5-9)',
    'POINT (17.9 .)',
  ])
    assert.equal(
      normalizeSpeedCamera(row({ Geometry: { WGS84: point } })),
      null,
      point,
    );
});

test('0 degrees and no direction are both no direction', () => {
  for (const bearing of [0, 360, -360, '', 'x', undefined])
    assert.equal(
      normalizeSpeedCamera(row({ Bearing: bearing })).bearing,
      null,
      String(bearing),
    );
  assert.equal(normalizeSpeedCamera(row({ Bearing: 0.5 })).bearing, 0.5);
  assert.equal(normalizeSpeedCamera(row({ Bearing: 359 })).bearing, 359);
});

test('the county is the first number that is one, list or single value', () => {
  const county = (CountyNo) => normalizeSpeedCamera(row({ CountyNo })).county;
  assert.equal(county([0, 12]), 'Skåne län');
  assert.equal(county(14), 'Västra Götalands län');
  assert.equal(county('3'), 'Uppsala län');
  assert.equal(county([2]), null);
  assert.equal(county([]), null);
  assert.equal(county(undefined), null);
});

test('the county numbers nothing could be read from are counted, most first', () => {
  assert.deepEqual(
    unreadCountyNumbers(
      answerOf([
        row({ Id: 'a', CountyNo: [1] }),
        row({ Id: 'b', CountyNo: [2] }),
        row({ Id: 'c', CountyNo: [2] }),
        row({ Id: 'd', CountyNo: [] }),
        row({ Id: 'e', CountyNo: [0, 99] }),
        row({ Id: 'f', CountyNo: ['<x>'] }),
      ]),
    ),
    [
      ['2', 2],
      ['none', 1],
      ['0+99', 1],
      ['?x?', 1],
    ],
  );
  assert.deepEqual(unreadCountyNumbers(answerOf([row()])), []);
  assert.throws(() => unreadCountyNumbers({}), /Malformed/);
});

test('a site that comes twice is kept once, the first of them', () => {
  assert.deepEqual(
    normalizeSpeedCameras(
      answerOf([
        row({ Id: 'a', Name: 'First' }),
        row({ Id: 'a', Name: 'Second' }),
        row({ Id: 'b' }),
      ]),
    ).map((camera) => [camera.id, camera.name]),
    [
      ['a', 'First'],
      ['b', 'Rotebro'],
    ],
  );
});

test('a road with a name keeps it whole', () => {
  assert.equal(
    normalizeSpeedCamera(row({ RoadNumber: ' Saltsjöbadsleden ' })).road,
    'Saltsjöbadsleden',
  );
  assert.equal(
    normalizeSpeedCamera(row({ RoadNumber: 'V'.repeat(60) })).road.length,
    40,
  );
});
