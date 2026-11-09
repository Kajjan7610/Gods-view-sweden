import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHELTERS_MAX_SPAN_DEG,
  clipViewBox,
  distanceMeters,
  normalizeShelter,
  normalizeShelters,
  sheltersInView,
} from './records.js';

const feature = (id, coordinates, props = {}) => ({
  type: 'Feature',
  id: `US_civilProtectionSite.${id}`,
  geometry: { type: 'MultiPoint', coordinates: [coordinates] },
  properties: {
    id,
    name: `1000${id}-7`,
    additionallocationdescription: 'Sundin 20',
    numberofoccupants: 33,
    status: 3,
    variantid: 1,
    ...props,
  },
});

test('a shelter keeps its number, property, places and state', () => {
  assert.deepEqual(normalizeShelter(feature(1, [15.5889175, 56.1582792])), {
    id: '1',
    point: [15.58892, 56.15828],
    number: '10001-7',
    property: 'Sundin 20',
    places: 33,
    limited: false,
    special: false,
  });
  const limited = normalizeShelter(
    feature(2, [18.06, 59.33], { status: 7, variantid: 2, numberofoccupants: 0 }),
  );
  assert.equal(limited.limited, true);
  assert.equal(limited.special, true);
  assert.equal(limited.places, null);
});

test('shelters outside Sweden or without an id are dropped, duplicates once', () => {
  assert.equal(normalizeShelter(feature(3, [2.35, 48.85])), null);
  assert.equal(normalizeShelter({ geometry: { type: 'Point', coordinates: [18, 59] } }), null);
  const rows = normalizeShelters([
    feature(4, [18.0, 59.3]),
    feature(4, [18.0, 59.3]),
    feature(5, [18.01, 59.3]),
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['4', '5']);
  assert.throws(() => normalizeShelters(null), /Malformed/);
});

test('a view counts its shelters and places and lists the nearest first', () => {
  const rows = normalizeShelters([
    feature(10, [18.0, 59.3], { numberofoccupants: 100 }),
    feature(11, [18.02, 59.3], { numberofoccupants: 50 }),
    feature(12, [18.01, 59.3], { numberofoccupants: 20 }),
    feature(13, [19.5, 59.3], { numberofoccupants: 999 }),
  ]);
  const view = sheltersInView(rows, { bbox: [17.9, 59.2, 18.1, 59.4], center: [18.0, 59.3], limit: 2 });
  assert.equal(view.total, 3);
  assert.equal(view.places, 170);
  assert.deepEqual(view.shelters.map((row) => row.id), ['10', '12']);
  assert.equal(view.shelters[0].distance, 0);
  assert.equal(Math.round(distanceMeters([18, 59.3], [18.01, 59.3])), 568);
});

test('a view box is cut to the span about the centre', () => {
  // Narrow enough: as it is, at 1e-4 degrees.
  assert.deepEqual(
    clipViewBox([17.90004, 59.2, 18.1, 59.4], [18, 59.3]),
    [17.9, 59.2, 18.1, 59.4],
  );
  // A tilted view: wide east-west, cut about the centre; north-south kept.
  assert.deepEqual(
    clipViewBox([14, 59, 24, 60.5], [18.1, 59.4]),
    [16.6, 59, 19.6, 60.5],
  );
  // The centre near an edge: the box stops at the view's own edge.
  assert.deepEqual(
    clipViewBox([14, 55, 24, 69], [14.5, 68.5]),
    [14, 67, 16, 69],
  );
  // The centre outside the view: the box around the centre.
  assert.deepEqual(
    clipViewBox([14, 59, 24, 60.5], [30, 59.4]),
    [28.5, 59, 31.5, 60.5],
  );
});

test('a cut box is never a hair wider than the span', () => {
  for (const lon of [18.0972, 11.97461, 20.22507, 15.00003]) {
    const [west, , east] = clipViewBox([lon - 6, 59, lon + 7, 60], [lon, 59.5]);
    assert.ok(
      Math.round((east - west) * 1e4) <= SHELTERS_MAX_SPAN_DEG * 1e4,
      `${west}..${east}`,
    );
  }
});
