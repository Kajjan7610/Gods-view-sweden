// The fork's layers hand their rows to the context panel and the analyst.
import assert from 'node:assert/strict';
import test from 'node:test';
import { analystPick, analystRows, middleOf } from './analystRows.js';

test('rows become records with a place, a name and a few fields', () => {
  const rows = [
    { id: 'a', name: 'Alfta', point: [16.03, 61.34], depth: 36 },
    { id: 'b', name: 'No place' },
    { id: 'c', name: 'Bunkris', point: [13.5, 61.2], depth: 126 },
  ];
  assert.deepEqual(
    analystRows(rows, 10, { extra: (row) => ({ depthCm: row.depth }) }),
    [
      { id: 'a', name: 'Alfta', lat: 61.34, lon: 16.03, depthCm: 36 },
      { id: 'c', name: 'Bunkris', lat: 61.2, lon: 13.5, depthCm: 126 },
    ],
  );
  assert.equal(analystRows(rows, 1).length, 1);
  assert.deepEqual(analystRows(null), []);
  assert.deepEqual(
    analystRows([{ id: 'x', at: { lon: 1, lat: 2 } }], 5, {
      place: (row) => [row.at.lon, row.at.lat],
      name: () => 'X',
    }),
    [{ id: 'x', name: 'X', lat: 2, lon: 1 }],
  );
});

test('a picked row is named and placed as its record is', () => {
  const row = { id: '21', name: 'Gullmarsleden', point: [11.6, 58.32] };
  assert.deepEqual(analystPick(row), {
    name: 'Gullmarsleden',
    latitude: 58.32,
    longitude: 11.6,
  });
  assert.deepEqual(
    analystPick(row, {
      place: () => [12, 59],
      name: (picked) => `Route ${picked.name}`,
    }),
    { name: 'Route Gullmarsleden', latitude: 59, longitude: 12 },
  );
  assert.equal(analystPick(null), null);
  assert.equal(analystPick({ id: 'x', name: 'No place' }), null);
});

test('the middle of a ring or line', () => {
  assert.deepEqual(
    middleOf([
      [10, 60],
      [12, 62],
    ]),
    [11, 61],
  );
  assert.equal(middleOf([]), null);
});
