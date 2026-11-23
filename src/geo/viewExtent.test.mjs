// Swedish fork: the ground in view, clipped around the look-at point, that
// the flights feed asks adsb.lol to cover.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipViewExtent,
  usableViewExtent,
  viewExtentArea,
} from './viewExtent.js';

const STOCKHOLM = { latitude: 59.33, longitude: 18.07 };
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual}`);

test('a view inside the box is kept as it is', () => {
  assert.deepEqual(
    clipViewExtent(
      { west: 10, south: 55, east: 25, north: 65 },
      STOCKHOLM,
      1500,
    ),
    { west: 10, south: 55, east: 25, north: 65 },
  );
});

test('a wider view is clipped to the box around the point, east and west at its latitude', () => {
  const clipped = clipViewExtent(
    { west: -40, south: 20, east: 80, north: 85 },
    STOCKHOLM,
    1000,
  );
  close(clipped.south, 59.33 - 1000 / 111.32, 'south');
  close(clipped.north, 59.33 + 1000 / 111.32, 'north');
  const reach = 1000 / (111.32 * Math.cos((59.33 * Math.PI) / 180));
  close(clipped.west, 18.07 - reach, 'west');
  close(clipped.east, 18.07 + reach, 'east');
});

test('a view across the antimeridian stays across it', () => {
  const fiji = { latitude: -17, longitude: 179 };
  const clipped = clipViewExtent(
    { west: 170, south: -25, east: -170, north: -10 },
    fiji,
    1500,
  );
  assert.ok(clipped.east < clipped.west, JSON.stringify(clipped));
  assert.equal(clipped.west, 170);
  assert.equal(clipped.east, -170);
  // A point east of the antimeridian is placed on the view's span too.
  const east = clipViewExtent(
    { west: 170, south: -25, east: -170, north: -10 },
    { latitude: -17, longitude: -178 },
    300,
  );
  assert.ok(east.east < east.west, JSON.stringify(east));
  close(
    east.west,
    -178 - 300 / (111.32 * Math.cos((17 * Math.PI) / 180)) + 360,
    'west',
  );
});

test('no extent for the whole globe, a pole in view, a view that misses the box, or numbers that are not a view', () => {
  assert.equal(
    clipViewExtent(
      { west: -180, south: -90, east: 180, north: 90 },
      STOCKHOLM,
      1500,
    ),
    null,
    'the whole globe',
  );
  assert.equal(
    clipViewExtent(
      { west: 40, south: 70, east: 39.9995, north: 90 },
      STOCKHOLM,
      1500,
    ),
    null,
    'every longitude, over a pole',
  );
  assert.equal(
    clipViewExtent(
      { west: 100, south: 10, east: 120, north: 20 },
      STOCKHOLM,
      1500,
    ),
    null,
    'far away',
  );
  for (const extent of [
    null,
    { west: 10, south: 60, east: 20, north: 55 },
    { west: 10, south: 55, east: 10, north: 60 },
    { west: 10, south: 55, east: 200, north: 60 },
    { west: 10, south: -95, east: 20, north: 60 },
    { west: NaN, south: 55, east: 20, north: 60 },
  ])
    assert.equal(clipViewExtent(extent, STOCKHOLM, 1500), null);
  assert.equal(
    clipViewExtent({ west: 10, south: 55, east: 20, north: 60 }, null, 1500),
    null,
  );
});

test('a view is usable as given unless it spans every longitude or is not a rectangle', () => {
  const sweden = { west: 4, south: 54, east: 30, north: 70 };
  assert.deepEqual(usableViewExtent(sweden), sweden);
  assert.deepEqual(
    usableViewExtent({ west: 170, south: -25, east: -170, north: -10 }),
    { west: 170, south: -25, east: -170, north: -10 },
  );
  for (const extent of [
    null,
    { west: -180, south: -90, east: 180, north: 90 },
    { west: 10, south: 60, east: 20, north: 55 },
    { west: 10, south: 55, east: 10, north: 60 },
    { west: NaN, south: 55, east: 20, north: 60 },
  ])
    assert.equal(usableViewExtent(extent), null, JSON.stringify(extent));
});

test('a view’s area weighs a part of it against the whole', () => {
  // A band from the equator to the pole is half a hemisphere’s area per 180°.
  close(
    viewExtentArea({ west: -90, south: 0, east: 90, north: 90 }),
    Math.PI,
    'a quarter of the sphere',
  );
  // Across the antimeridian as on either side of it.
  close(
    viewExtentArea({ west: 170, south: 0, east: -170, north: 10 }),
    viewExtentArea({ west: 0, south: 0, east: 20, north: 10 }),
    'antimeridian',
  );
  const view = { west: -40, south: 20, east: 80, north: 85 };
  const part = clipViewExtent(view, STOCKHOLM, 1000);
  const share = viewExtentArea(part) / viewExtentArea(view);
  assert.ok(share > 0.02 && share < 0.2, String(share));
});
