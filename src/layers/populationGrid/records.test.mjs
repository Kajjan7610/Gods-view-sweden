import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DENSITY_CLASSES,
  decodeLevel,
  densityClass,
  levelForBox,
  readSquareRow,
  roundedPeople,
  shownDensity,
  squareCentre,
  squareCorners,
  squareRow,
  squaresInView,
} from './records.js';
import { buildSquareCard, classLabel } from './cards.js';

test('a density falls in its colour class', () => {
  assert.equal(densityClass(0.2), 0);
  assert.equal(densityClass(1), 1);
  assert.equal(densityClass(4), 1);
  assert.equal(densityClass(5), 2);
  assert.equal(densityClass(99.9), 3);
  assert.equal(densityClass(100), 4);
  assert.equal(densityClass(1999), 5);
  assert.equal(densityClass(25_000), 6);
  assert.deepEqual(
    DENSITY_CLASSES.map((_, index) => classLabel(index)),
    [
      'under 1 per km²',
      '1–4 per km²',
      '5–19 per km²',
      '20–99 per km²',
      '100–499 per km²',
      '500–1,999 per km²',
      '2,000+ per km²',
    ],
  );
});

test('a summed square’s people are rounded, and few people are no number', () => {
  assert.equal(roundedPeople(0), null);
  assert.equal(roundedPeople(4), null);
  assert.equal(roundedPeople(5), 10);
  assert.equal(roundedPeople(14), 10);
  assert.equal(roundedPeople(1236), 1240);
  assert.equal(roundedPeople(23_456), 23_500);
});

test('a view is read at a square size that keeps it to a few thousand squares', () => {
  // Central Stockholm, some 20 km across: 1 km squares.
  assert.equal(levelForBox([17.9, 59.25, 18.2, 59.4]), 1);
  // Mälardalen, some 150 km: 5 km sums.
  assert.equal(levelForBox([16.5, 59, 18.9, 60]), 5);
  // Southern Sweden, some 450 km: 10 km sums.
  assert.equal(levelForBox([12, 55.3, 19, 59]), 10);
  // All of Sweden: 25 km sums.
  assert.equal(levelForBox([10, 55, 24.5, 69.2]), 25);
});

test('a packed level unpacks to corners and values', () => {
  // Three 5 km squares: (2, 3), (3, 3) and (2, 4) from origin (100, 1300),
  // in a level 10 squares wide.
  const { east, north, values } = decodeLevel(
    { origin: [100, 1300], width: 10, cells: [32, 7, 1, 12, 9, 400] },
    5,
  );
  assert.deepEqual([...east], [510_000, 515_000, 510_000]);
  assert.deepEqual([...north], [6_515_000, 6_515_000, 6_520_000]);
  assert.deepEqual([...values], [7, 12, 400]);
});

test('a square’s corners are SWEREF 99 TM turned to degrees', () => {
  // The square of Stockholm's Sergels torg, SCB id 6740006580000.
  const corners = squareCorners(674_000, 6_580_000, 1);
  assert.equal(corners.length, 4);
  const [lon, lat] = corners[0];
  assert.ok(
    lon > 18.05 && lon < 18.08 && lat > 59.32 && lat < 59.34,
    corners[0],
  );
  // East of the central meridian (15° E) the grid is turned: the square's
  // south edge sinks to lower latitudes as it runs east.
  assert.ok(corners[1][1] < corners[0][1]);
  const [cLon, cLat] = squareCentre(674_000, 6_580_000, 1);
  assert.ok(cLon > lon && cLat > lat);
});

test('the squares in a view come nearest its centre first', () => {
  const lon = Float64Array.from([18.0, 18.1, 15.0, 18.05]);
  const lat = Float64Array.from([59.3, 59.35, 62.0, 59.31]);
  assert.deepEqual(
    squaresInView({ lon, lat }, [17.9, 59.2, 18.2, 59.4], 1, 10),
    [3, 0, 1],
  );
  assert.deepEqual(
    squaresInView({ lon, lat }, [17.9, 59.2, 18.2, 59.4], 1, 1),
    [3],
  );
});

test('a 1 km square leaves the server as its class alone', () => {
  // The snapshot keeps a 1 km square's class, never its count.
  assert.deepEqual(squareRow(674_000, 6_580_000, 1, 1), [674, 6580, 1]);
  assert.deepEqual(squareRow(674_000, 6_580_000, 6, 1), [674, 6580, 6]);
  // A count where a class belongs is refused, not sent.
  assert.throws(() => squareRow(674_000, 6_580_000, 4321, 1));
  assert.throws(() => squareRow(674_000, 6_580_000, 0, 1));
  const square = readSquareRow([674, 6580, 1, 3], 1);
  assert.equal(square.people, null, 'a 1 km square never carries people');
  assert.equal(square.summed, false);
  assert.equal(readSquareRow(['x', 6580, 1], 1), null);
  assert.equal(readSquareRow([674, 6580, 9], 1), null);
});

test('a summed square carries its rounded people and their class', () => {
  // 3 people in 25 km²: no number, under 1 per km².
  assert.deepEqual(squareRow(670_000, 6_580_000, 3, 5), [670, 6580, 0, null]);
  // 1 236 people in 25 km²: about 1 240, 49.6 per km².
  assert.deepEqual(
    squareRow(670_000, 6_580_000, 1236, 5),
    [670, 6580, 3, 1240],
  );
  const square = readSquareRow([670, 6580, 3, 1240], 5);
  assert.equal(square.id, '5:670:6580');
  assert.equal(shownDensity(square), 50);
  assert.equal(shownDensity({ people: 90, km: 5 }), 3.6);
  assert.equal(shownDensity({ people: null, km: 5 }), null);
});

test('a summed square’s card shows rounded people and density, credited as processed', () => {
  const card = buildSquareCard(readSquareRow([670, 6580, 3, 1240], 5));
  assert.equal(card.title, 'POPULATION · 5 km square');
  assert.deepEqual(card.details, [
    'about 1,240 people',
    '50 per km²',
    'Summed from SCB’s 1 km grid, end of 2025',
    'Processed from SCB data',
  ]);
  assert.equal(card.accent, DENSITY_CLASSES[3].color);
  const few = buildSquareCard(readSquareRow([670, 6580, 0, null], 25));
  assert.deepEqual(few.details.slice(0, 2), [
    'fewer than 5 people',
    'under 1 per km²',
  ]);
});
