import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, statSync } from 'node:fs';

import {
  MAX_SQUARES,
  POPULATION_GRID_FILE,
  populationGridProxy,
} from './populationGrid.js';
import {
  GRID_LEVELS_KM,
  DENSITY_CLASSES,
  decodeLevel,
  densityClass,
} from '../../src/layers/populationGrid/records.js';

function harness(options) {
  let route;
  let handler;
  populationGridProxy(options).configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async (url) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

const box = (w, s, e, n) => `/?west=${w}&south=${s}&east=${e}&north=${n}`;
/**
 * One level of single squares at SWEREF corners (m), packed as the build
 * does: a 1 km square as its class, a summed one as its people.
 */
function level(km, squares) {
  const size = km * 1000;
  const places = squares.map(([east, north, people]) => [
    east / size,
    north / size,
    km === 1 ? densityClass(people) : people,
  ]);
  const originColumn = Math.min(...places.map(([c]) => c));
  const originRow = Math.min(...places.map(([, r]) => r));
  const width = Math.max(...places.map(([c]) => c)) - originColumn + 1;
  const keyed = places
    .map(([c, r, people]) => [
      (r - originRow) * width + (c - originColumn),
      people,
    ])
    .sort((p, q) => p[0] - q[0]);
  const cells = [];
  let previous = 0;
  for (const [place, people] of keyed) {
    cells.push(place - previous, people);
    previous = place;
  }
  return {
    value: km === 1 ? 'class' : 'people',
    origin: [originColumn, originRow],
    width,
    cells,
  };
}

// Two squares in central Stockholm (3 and 4 321 people) and one in Kiruna.
const SQUARES = [
  [674_000, 6_580_000, 3],
  [675_000, 6_580_000, 4321],
  [758_000, 7_536_000, 250],
];
const SNAPSHOT = {
  source: 'SCB',
  year: 2025,
  referenceDate: '2025-12-31',
  built: '2026-11-19',
  squares: 3,
  population: 4574,
  levels: Object.fromEntries(
    GRID_LEVELS_KM.map((km) => {
      const size = km * 1000;
      const sums = new Map();
      for (const [east, north, people] of SQUARES) {
        const key = `${Math.floor(east / size)}:${Math.floor(north / size)}`;
        const sum = sums.get(key) ?? [
          Math.floor(east / size) * size,
          Math.floor(north / size) * size,
          0,
        ];
        sum[2] += people;
        sums.set(key, sum);
      }
      return [km, level(km, [...sums.values()])];
    }),
  ),
};

test('a close view gets 1 km squares as their classes alone, read once', async (t) => {
  t.mock.method(console, 'log', () => {});
  let reads = 0;
  const request = harness({
    read: async () => {
      reads += 1;
      return JSON.stringify(SNAPSHOT);
    },
  });
  assert.equal(request.route(), '/api/population-grid');
  const close = await request(box(17.95, 59.28, 18.2, 59.38));
  assert.equal(close.status, 200);
  assert.equal(close.json.level, 1);
  assert.equal(close.json.capped, false);
  assert.equal(close.json.source, 'SCB');
  assert.equal(close.json.year, 2025);
  // No people for a 1 km square: 3 people is the class "1–4", nothing more.
  assert.deepEqual(
    close.json.squares.sort((p, q) => p[0] - q[0]),
    [
      [674, 6580, 1],
      [675, 6580, 6],
    ],
  );
  await request(box(17.95, 59.28, 18.2, 59.38));
  assert.equal(reads, 1);
});

test('a wide view gets the summed squares, people rounded', async (t) => {
  t.mock.method(console, 'log', () => {});
  const request = harness({ read: async () => JSON.stringify(SNAPSHOT) });
  const sweden = await request(box(10, 55, 24.5, 69.2));
  assert.equal(sweden.json.level, 25);
  // Stockholm's two 25 km squares: 3 people, no number; 4 321, about
  // 4 320, 6.9 per km². Kiruna's: 250, 0.4 per km².
  assert.deepEqual(
    sweden.json.squares.sort((p, q) => p[1] - q[1] || p[0] - q[0]),
    [
      [650, 6575, 0, null],
      [675, 6575, 2, 4320],
      [750, 7525, 0, 250],
    ],
  );
});

test('a view must be a box', async () => {
  const request = harness({ read: async () => '{}' });
  for (const url of ['/', box('x', 59, 18, 60), box(18, 59, 17, 60)])
    assert.equal((await request(url)).status, 400, url);
});

test('two first views read the snapshot once', async (t) => {
  t.mock.method(console, 'log', () => {});
  let reads = 0;
  const request = harness({
    read: async () => {
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return JSON.stringify(SNAPSHOT);
    },
  });
  const answers = await Promise.all([
    request(box(17.95, 59.28, 18.2, 59.38)),
    request(box(10, 55, 24.5, 69.2)),
  ]);
  assert.deepEqual(
    answers.map(({ status }) => status),
    [200, 200],
  );
  assert.equal(reads, 1);
});

test('a snapshot with 1 km counts is never served', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let reads = 0;
  const old = structuredClone(SNAPSHOT);
  old.levels[1].value = 'people';
  const request = harness({
    read: async () => {
      reads += 1;
      return JSON.stringify(reads === 1 ? old : SNAPSHOT);
    },
  });
  const close = box(17.95, 59.28, 18.2, 59.38);
  assert.equal((await request(close)).status, 502);
  // A failed read is tried again by the next view.
  assert.equal((await request(close)).status, 200);
  assert.equal(reads, 2);
});

test('an unreadable snapshot answers 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness({ read: async () => '{"levels":{}}' });
  const answer = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.equal(answer.status, 502);
  assert.equal(answer.json.error, 'population_grid_unavailable');
});

test('the bundled snapshot holds SCB’s 2025 grid for all of Sweden', () => {
  assert.ok(statSync(POPULATION_GRID_FILE).size < 1_500_000);
  const snapshot = JSON.parse(readFileSync(POPULATION_GRID_FILE, 'utf8'));
  assert.equal(snapshot.source, 'SCB');
  assert.equal(snapshot.year, 2025);
  assert.equal(snapshot.referenceDate, '2025-12-31');
  assert.ok(snapshot.squares > 100_000, `${snapshot.squares} squares`);
  assert.ok(
    snapshot.population > 10_400_000 && snapshot.population < 11_000_000,
    `${snapshot.population} people`,
  );
  // Totals only: no ages or sexes anywhere in the file.
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'built',
    'levels',
    'population',
    'referenceDate',
    'source',
    'squares',
    'year',
  ]);
  for (const km of GRID_LEVELS_KM) {
    const level = snapshot.levels[km];
    const { east, north, values } = decodeLevel(level, km);
    if (km === 1) {
      // No exact 1 km count in the file: a class per square, 1–4 the least.
      assert.equal(level.value, 'class');
      assert.equal(values.length, snapshot.squares);
      assert.ok(
        values.every((value) => value >= 1 && value < DENSITY_CLASSES.length),
      );
    } else {
      assert.equal(level.value, 'people');
      assert.equal(
        values.reduce((sum, value) => sum + value, 0),
        snapshot.population,
        `${km} km`,
      );
    }
    for (let index = 0; index < values.length; index += 1) {
      assert.ok(values[index] > 0);
      assert.equal(east[index] % (km * 1000), 0);
      assert.ok(east[index] >= 200_000 && east[index] < 1_000_000);
      assert.ok(north[index] >= 6_100_000 && north[index] < 7_700_000);
    }
  }
  assert.ok(MAX_SQUARES >= 2500);
});

test('the bundled grid serves Stockholm close up and Sweden whole within the cap', async (t) => {
  t.mock.method(console, 'log', () => {});
  const request = harness();
  const stockholm = await request(box(17.85, 59.22, 18.3, 59.45));
  assert.equal(stockholm.json.level, 1);
  assert.ok(stockholm.json.squares.length > 300);
  assert.ok(stockholm.json.squares.every((row) => row.length === 3));
  const sweden = await request(box(10, 55, 24.5, 69.2));
  assert.equal(sweden.json.level, 25);
  assert.equal(sweden.json.capped, false);
  assert.ok(sweden.json.squares.length > 500);
  // No summed square tells an exact small count.
  for (const [, , , people] of sweden.json.squares)
    assert.ok(people === null || people % 10 === 0, String(people));
});
