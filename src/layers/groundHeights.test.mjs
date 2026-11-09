import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROUND_RETRY_FIRST_MS,
  GROUND_RETRY_MAX_MS,
  createGroundHeights,
  resolveGroundHeights,
} from './groundHeights.js';

const rows = [
  { id: 'a', point: [18.06, 59.33] },
  { id: 'b', point: [20.22, 67.85] },
];

/**
 * A terrain service answering from a table of `lat -> [height, source]`,
 * recording the points asked; the table can change between calls.
 */
function fakeTerrain(table, asked = []) {
  return {
    async resolveEllipsoidalGround(coords) {
      asked.push(...coords);
      return coords.map(({ lat }) =>
        lat in table
          ? { ellipsoid: table[lat][0], source: table[lat][1] }
          : { ellipsoid: null, source: 'unresolved' },
      );
    },
  };
}

/** Timers a test can run by hand. */
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (id) => pending.delete(id),
    async fire() {
      const [[id, { fn }]] = pending;
      pending.delete(id);
      await fn();
    },
  };
}

test('heights come back by row id with where they came from', async () => {
  const heights = await resolveGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'] }),
    rows,
  );
  assert.deepEqual([...heights], [['a', { height: 38, real: true }]]);
  assert.equal((await resolveGroundHeights(null, rows)).size, 0);
  assert.equal((await resolveGroundHeights(fakeTerrain({}), [])).size, 0);
});

test('a layer asks once per row and redraws when heights arrive', async () => {
  const asked = [];
  let redraws = 0;
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] }, asked),
    () => redraws++,
    timers,
  );
  assert.equal(ground.enabled, true);
  assert.equal(ground.heightOf('a'), 0);
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 38);
  assert.equal(ground.heightOf('b'), 575);
  assert.equal(redraws, 1);
  assert.equal(timers.pending.size, 0, 'nothing left to retry');
  await ground.place(rows);
  assert.equal(asked.length, 2, 'real heights are not asked again');
  ground.clear();
  assert.equal(ground.heightOf('b'), 0);
});

test('a geoid stand-in is drawn, then asked again until Re:Earth answers', async () => {
  const table = { 59.33: [38, 'reearth'], 67.85: [30, 'geoid-fallback'] };
  const asked = [];
  let redraws = 0;
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain(table, asked),
    () => redraws++,
    timers,
  );
  await ground.place(rows);
  assert.equal(ground.heightOf('b'), 30);
  assert.equal(ground.isReal('b'), false);
  assert.deepEqual(
    [...timers.pending.values()].map((t) => t.ms),
    [GROUND_RETRY_FIRST_MS],
  );
  // Still down: the same stand-in, no redraw, a longer wait.
  await timers.fire();
  assert.equal(redraws, 1);
  assert.deepEqual(
    [...timers.pending.values()].map((t) => t.ms),
    [GROUND_RETRY_FIRST_MS * 2],
  );
  assert.deepEqual(
    asked.slice(2).map((c) => c.lat),
    [67.85],
    'only the stand-in row is asked again',
  );
  // Back up: the real height replaces it and the retries stop.
  table[67.85] = [575, 'reearth'];
  await timers.fire();
  assert.equal(ground.heightOf('b'), 575);
  assert.equal(ground.isReal('b'), true);
  assert.equal(redraws, 2);
  assert.equal(timers.pending.size, 0);
});

test('the retry wait stops growing and ends when the layer is cancelled', async () => {
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [20, 'geoid-fallback'] }),
    () => {},
    timers,
  );
  await ground.place([rows[0]]);
  for (let i = 0; i < 8; i++) await timers.fire();
  assert.deepEqual(
    [...timers.pending.values()].map((t) => t.ms),
    [GROUND_RETRY_MAX_MS],
  );
  ground.cancel();
  assert.equal(timers.pending.size, 0);
  assert.equal(ground.heightOf('a'), 20, 'known heights stay');
});

test('without a terrain service nothing is asked and dots clamp as before', async () => {
  const ground = createGroundHeights(null, () => assert.fail('no redraw'));
  assert.equal(ground.enabled, false);
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 0);
});

test('a failed lookup leaves the dots where they are and tries again', async () => {
  const timers = manualTimers();
  const ground = createGroundHeights(
    {
      async resolveEllipsoidalGround() {
        throw new Error('down');
      },
    },
    () => assert.fail('no redraw'),
    timers,
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    await ground.place(rows);
  } finally {
    console.warn = warn;
  }
  assert.equal(ground.heightOf('a'), 0);
  assert.equal(timers.pending.size, 1);
  ground.clear();
});
