import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nearestSeat,
  normalizeFireStation,
  normalizeFireStations,
  readinessColor,
} from './records.js';

const SEATS = [
  ['1782', 'Säffle', '', 12.93, 59.13],
  ['1784', 'Arvika', '', 12.59, 59.65],
];
const feature = (id, coordinates, readiness, extra = {}) => ({
  type: 'Feature',
  id: `US_fireStation.${id}`,
  geometry: { type: 'Point', coordinates },
  properties: { inspireid: id, hogstaberedskapsform: readiness, ...extra },
});

test('a station keeps its position, readiness and nearest seat', () => {
  const row = normalizeFireStation(
    feature('a-1', [13.192793, 59.394783], 'Deltid (RiB) med FIP/FIB'),
    SEATS,
  );
  assert.deepEqual(row, {
    id: 'a-1',
    point: [13.19279, 59.39478],
    name: null,
    readiness: 'retained-officer',
    near: { name: 'Säffle', km: 33 },
  });
  assert.equal(readinessColor(row.readiness), '#fb8c00');
});

test('stations outside Sweden, without an id or with unknown readiness are handled', () => {
  assert.equal(
    normalizeFireStation(feature('b', [2.35, 48.85], 'Heltid')),
    null,
  );
  assert.equal(
    normalizeFireStation({
      geometry: { coordinates: [15, 60] },
      properties: {},
    }),
    null,
  );
  const unknown = normalizeFireStation(feature('c', [15, 60], 'Annan'));
  assert.equal(unknown.readiness, null);
  assert.equal(unknown.near, null);
  assert.equal(readinessColor(null), '#bdbdbd');
  assert.equal(
    normalizeFireStation(feature('d', [15, 60], 'Heltid', { name: ' Ystad ' }))
      .name,
    'Ystad',
  );
});

test('the collection sorts by readiness and drops duplicates', () => {
  const rows = normalizeFireStations({
    features: [
      feature('x', [15, 60], 'Kommunalt räddningsvärn'),
      feature('y', [16, 61], 'Heltid'),
      feature('y', [16, 61], 'Heltid'),
      feature('z', [17, 62], 'Deltid (RiB) utan FIP/FIB'),
    ],
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.readiness]),
    [
      ['y', 'full-time'],
      ['z', 'retained'],
      ['x', 'rescue-post'],
    ],
  );
  assert.throws(() => normalizeFireStations({}));
});

test('the nearest seat is the closest by distance', () => {
  assert.deepEqual(nearestSeat([12.6, 59.6], SEATS), {
    name: 'Arvika',
    km: 6,
  });
  assert.equal(nearestSeat([12.6, 59.6], []), null);
});
