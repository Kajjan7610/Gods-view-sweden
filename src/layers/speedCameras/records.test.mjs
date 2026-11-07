// Trafikverket's camera sites: parsing, compass points and nearness.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  camerasNear,
  compassIndex,
  COMPASS,
  normalizeSpeedCamera,
  normalizeSpeedCameras,
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
