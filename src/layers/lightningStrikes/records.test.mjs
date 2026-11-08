import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGE_CLASSES,
  WINDOW_MS,
  ageClass,
  normalizeStrike,
  normalizeStrikes,
} from './records.js';

const NOW = Date.parse('2026-07-10T15:00:00Z');
const feature = (
  id,
  minutesAgo,
  coordinates = [14.1868, 55.697],
  extra = {},
) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates },
  properties: {
    strokes: 1,
    sensors: '1,2,3,4',
    amp: -12.34,
    type: 0,
    observed: new Date(NOW - minutesAgo * 60_000).toISOString(),
    ...extra,
  },
});

test('a stroke keeps its place, time, kind, current and sensor count', () => {
  assert.deepEqual(normalizeStrike(feature('u3bq-01', 3)), {
    id: 'u3bq-01',
    point: [14.1868, 55.697],
    at: NOW - 3 * 60_000,
    kind: 'ground-negative',
    amp: -12.3,
    sensors: 4,
  });
  assert.equal(
    normalizeStrike(feature('a', 1, undefined, { type: 1 })).kind,
    'ground-positive',
  );
  assert.equal(
    normalizeStrike(feature('a', 1, undefined, { type: 2 })).kind,
    'cloud',
  );
  assert.equal(
    normalizeStrike(feature('a', 1, undefined, { type: 9 })).kind,
    null,
  );
  assert.equal(normalizeStrike(feature('a', 1, [-40, 10])), null);
  assert.equal(normalizeStrike(feature('', 1)), null);
  assert.equal(
    normalizeStrike(feature('a', 1, undefined, { observed: 'x' })),
    null,
  );
});

test('the collection keeps the last hour, newest first, without repeats', () => {
  const rows = normalizeStrikes(
    [
      feature('old', 61),
      feature('b', 20),
      feature('a', 2),
      feature('a', 2),
      feature('future', -5),
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a', 'b'],
  );
  assert.throws(() => normalizeStrikes(null, NOW));
});

test('age classes cover the window and nothing past it', () => {
  assert.equal(ageClass(0), AGE_CLASSES[0]);
  assert.equal(ageClass(4.9 * 60_000), AGE_CLASSES[0]);
  assert.equal(ageClass(10 * 60_000), AGE_CLASSES[1]);
  assert.equal(ageClass(29 * 60_000), AGE_CLASSES[2]);
  assert.equal(ageClass(59 * 60_000), AGE_CLASSES[3]);
  assert.equal(ageClass(WINDOW_MS), null);
});
