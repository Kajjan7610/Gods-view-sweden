import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AURORA_SOUTH,
  AURORA_TOWNS,
  auroraColor,
  chanceAt,
  latestKp,
  normalizeOvation,
} from './records.js';

// Shaped like ovation_aurora_latest.json: [lon 0..359 E, lat, chance].
const PAYLOAD = {
  'Observation Time': '2026-11-04T21:58:00Z',
  'Forecast Time': '2026-11-04T23:04:00Z',
  'Data Format': '[Longitude, Latitude, Aurora]',
  coordinates: [
    [20, 68, 22],
    [340, 65, 40],
    [16, 60, 4],
    [10, -70, 50],
    [0, 29, 9],
    [5, 70, 'x'],
  ],
};

test('the northern band keeps chances by latitude row and longitude', () => {
  const grid = normalizeOvation(PAYLOAD);
  assert.equal(grid.rows.length, 90 - AURORA_SOUTH + 1);
  assert.equal(grid.rows[0].length, 360);
  assert.equal(grid.observed, Date.parse('2026-11-04T21:58:00Z'));
  assert.equal(grid.forecast, Date.parse('2026-11-04T23:04:00Z'));
  assert.equal(chanceAt(grid, [20.23, 67.86]), 22, 'Kiruna');
  assert.equal(chanceAt(grid, [-20, 65]), 40, 'west longitudes wrap to 340 E');
  assert.equal(chanceAt(grid, [10, -70]), 0, 'the south is not kept');
  assert.equal(chanceAt(grid, [0, 29]), 0, 'below the band');
  assert.throws(() => normalizeOvation({}), /Malformed/);
});

test('the colour ramp starts at 3 % and the towns run north to south', () => {
  assert.equal(auroraColor(2), null);
  assert.equal(auroraColor(5), '#1de9b6');
  assert.equal(auroraColor(15), '#00e676');
  assert.equal(auroraColor(35), '#ffd600');
  assert.equal(auroraColor(80), '#ff1744');
  const lats = AURORA_TOWNS.map((town) => town.point[1]);
  assert.deepEqual(
    lats,
    [...lats].sort((a, b) => b - a),
  );
});

test('the newest Kp is read from the K-index list', () => {
  assert.deepEqual(
    latestKp([
      { time_tag: '2026-11-04T15:00:00', Kp: 1 },
      { time_tag: '2026-11-04T18:00:00', Kp: 1.67 },
      { time_tag: '2026-11-04T21:00:00', Kp: null },
    ]),
    { kp: 1.67, at: Date.parse('2026-11-04T18:00:00Z') },
  );
  assert.equal(latestKp({}), null);
});
