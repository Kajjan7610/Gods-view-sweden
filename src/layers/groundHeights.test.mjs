import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  GROUND_RETRY_FIRST_MS,
  GROUND_CHUNK,
  GROUND_RETRY_MAX_MS,
  GROUND_STORE_KEY,
  GROUND_STORE_MAX,
  clearGroundHeightStore,
  createGroundHeights,
} from './groundHeights.js';

const rows = [
  { id: 'a', point: [18.06, 59.33] },
  { id: 'b', point: [20.22, 67.85] },
];

/** `count` rows at places of their own. */
const many = (count, lat = 61, prefix = 'p') =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    point: [16 + i / 1000, lat],
  }));

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

/** A terrain service where every place is 40 m up, recording each request. */
function flatTerrain(calls = [], before = async () => {}) {
  return {
    async resolveEllipsoidalGround(coords) {
      calls.push(coords.length);
      await before(calls.length);
      return coords.map(() => ({ ellipsoid: 40, source: 'reearth' }));
    },
  };
}

beforeEach(() => clearGroundHeightStore());

const moment = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Timers a test can run by hand. */
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    gapMs: 0,
    pending,
    setTimer: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (id) => pending.delete(id),
    waits: () => [...pending.values()].map((timer) => timer.ms),
    // A retry does not hand back its lookup; let it finish before looking.
    async fire() {
      const [[id, { fn }]] = pending;
      pending.delete(id);
      fn();
      await moment();
    },
  };
}

/** A gate a fake request can wait at. */
function gate() {
  let open;
  const closed = new Promise((resolve) => (open = resolve));
  return { closed, open };
}

/** Collect what is warned while `run` goes on. */
async function warnings(run) {
  const warn = console.warn;
  const said = [];
  console.warn = (...args) => said.push(args);
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return said;
}

/** Browser storage, as far as the kept heights use it. */
function fakeStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

/** Run with browser globals in place; the store reads them on its next use. */
async function withGlobals(globals, run) {
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  try {
    await run();
  } finally {
    clearGroundHeightStore();
    for (const name of Object.keys(globals)) delete globalThis[name];
  }
}

test('heights are known by row id, with where they came from', async () => {
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'] }),
    () => {},
    manualTimers(),
  );
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 38);
  assert.equal(ground.isReal('a'), true);
  // No answer for the other place: it stays on the ellipsoid.
  assert.equal(ground.heightOf('b'), 0);
  assert.equal(ground.isReal('b'), false);
  ground.clear();
  await createGroundHeights(fakeTerrain({}), () =>
    assert.fail('no redraw'),
  ).place([]);
});

test('a layer asks once per row and is told when heights arrive', async () => {
  const asked = [];
  const told = [];
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] }, asked),
    (ids) => told.push(ids),
    timers,
  );
  assert.equal(ground.enabled, true);
  assert.equal(ground.heightOf('a'), 0);
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 38);
  assert.equal(ground.heightOf('b'), 575);
  assert.deepEqual(told, [['a', 'b']]);
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
  assert.deepEqual(timers.waits(), [GROUND_RETRY_FIRST_MS]);
  // Still down: the same stand-in, no redraw, a longer wait.
  await timers.fire();
  assert.equal(redraws, 1);
  assert.deepEqual(timers.waits(), [GROUND_RETRY_FIRST_MS * 2]);
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

test('a later update does not ask a stand-in row again before its wait is over', async () => {
  const table = { 59.33: [38, 'reearth'], 67.85: [30, 'geoid-fallback'] };
  const asked = [];
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain(table, asked),
    () => {},
    timers,
  );
  await ground.place(rows);
  // The layer polls: the same rows come again and again.
  for (let i = 0; i < 3; i++) await ground.place(rows);
  assert.equal(asked.length, 2);
  assert.deepEqual(timers.waits(), [GROUND_RETRY_FIRST_MS], 'the same wait');
  // Off and on again changes nothing either.
  ground.cancel();
  await ground.place(rows);
  assert.equal(asked.length, 2);
  assert.deepEqual(timers.waits(), [GROUND_RETRY_FIRST_MS]);
  // A row that is new is asked at once.
  await ground.place([...rows, { id: 'c', point: [13, 55.6] }]);
  assert.deepEqual(
    asked.slice(2).map((c) => c.lat),
    [55.6],
  );
  ground.clear();
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
  assert.deepEqual(timers.waits(), [GROUND_RETRY_MAX_MS]);
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

test('a failed lookup leaves the dots where they are and waits to try again', async () => {
  const timers = manualTimers();
  let calls = 0;
  const ground = createGroundHeights(
    {
      async resolveEllipsoidalGround() {
        calls += 1;
        throw new Error('down');
      },
    },
    () => assert.fail('no redraw'),
    timers,
  );
  const said = await warnings(async () => {
    await ground.place(rows);
    assert.equal(ground.heightOf('a'), 0);
    assert.equal(timers.pending.size, 1);
    // An update meanwhile asks nothing: the wait is the back-off.
    await ground.place(rows);
    assert.equal(calls, 1);
    await timers.fire();
    assert.equal(calls, 2);
    assert.deepEqual(timers.waits(), [GROUND_RETRY_FIRST_MS * 2]);
  });
  assert.deepEqual(said, [
    ['[GroundHeights] lookup failed:', 'down'],
    ['[GroundHeights] lookup failed:', 'down'],
  ]);
  ground.clear();
});

test('a failure midway keeps the heights that came before it', async () => {
  const calls = [];
  const told = [];
  const timers = manualTimers();
  const ground = createGroundHeights(
    flatTerrain(calls, async (call) => {
      if (call === 2) throw new Error('down');
    }),
    (ids) => told.push(ids.length),
    timers,
  );
  const said = await warnings(() => ground.place(many(GROUND_CHUNK + 5)));
  assert.equal(said.length, 1);
  assert.equal(ground.heightOf('p0'), 40);
  assert.equal(ground.heightOf(`p${GROUND_CHUNK}`), 0);
  assert.deepEqual(told, [GROUND_CHUNK]);
  assert.equal(timers.pending.size, 1);
  // The retry asks for what was left, not for everything.
  await timers.fire();
  assert.deepEqual(calls, [GROUND_CHUNK, 5, 5]);
  assert.equal(ground.heightOf(`p${GROUND_CHUNK}`), 40);
  assert.deepEqual(told, [GROUND_CHUNK, 5]);
  assert.equal(timers.pending.size, 0);
});

test('kept heights are in place before the first draw, with nothing asked', async () => {
  const asked = [];
  const terrain = fakeTerrain({ 59.33: [38, 'reearth'] }, asked);
  await createGroundHeights(terrain, () => {}, manualTimers()).place([rows[0]]);
  const later = createGroundHeights(
    terrain,
    () => assert.fail('no redraw'),
    manualTimers(),
  );
  const done = later.place([{ id: 'other', point: [18.06, 59.33] }]);
  // Not awaited: a layer draws right after this call.
  assert.equal(later.heightOf('other'), 38);
  assert.equal(later.isReal('other'), true);
  await done;
  assert.equal(asked.length, 1, 'the second layer asked nothing');
});

test('rows at one place share a lookup; many places go in chunks', async () => {
  const calls = [];
  const same = [
    { id: 'x', point: [15, 60] },
    { id: 'y', point: [15, 60] },
  ];
  const told = [];
  const ground = createGroundHeights(
    flatTerrain(calls),
    (ids) => told.push(ids),
    manualTimers(),
  );
  await ground.place(same);
  assert.deepEqual(calls, [1]);
  assert.equal(ground.heightOf('y'), 40);
  assert.deepEqual(told, [['x', 'y']]);
  calls.length = 0;
  await ground.place(many(GROUND_CHUNK + 5));
  assert.deepEqual(calls, [GROUND_CHUNK, 5]);
});

test('heights arrive a request at a time, for the rows they changed', async () => {
  const second = gate();
  const told = [];
  const ground = createGroundHeights(
    flatTerrain([], (call) => (call === 2 ? second.closed : undefined)),
    (ids) => told.push(ids),
    manualTimers(),
  );
  const done = ground.place(many(GROUND_CHUNK + 5));
  await moment();
  // The second request is still out; the first one's rows are in place.
  assert.equal(told.length, 1);
  assert.equal(told[0].length, GROUND_CHUNK);
  assert.equal(told[0][0], 'p0');
  assert.equal(ground.heightOf('p0'), 40);
  assert.equal(ground.heightOf(`p${GROUND_CHUNK}`), 0);
  second.open();
  await done;
  assert.deepEqual(
    told[1],
    [0, 1, 2, 3, 4].map((i) => `p${GROUND_CHUNK + i}`),
  );
});

test('requests from every layer keep their distance', async () => {
  const at = [];
  const terrain = {
    async resolveEllipsoidalGround(coords) {
      at.push(Date.now());
      return coords.map(() => ({ ellipsoid: 1, source: 'reearth' }));
    },
  };
  const layer = () =>
    createGroundHeights(terrain, () => {}, { ...manualTimers(), gapMs: 60 });
  await Promise.all([
    layer().place([{ id: 'a', point: [11, 57] }]),
    layer().place([{ id: 'b', point: [12, 57] }]),
  ]);
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 55, `${at[1] - at[0]} ms apart`);
});

test('a cancelled lookup gives its turn away', async () => {
  const at = [];
  const terrain = (name) => ({
    async resolveEllipsoidalGround(coords) {
      at.push([name, Date.now()]);
      return coords.map(() => ({ ellipsoid: 1, source: 'reearth' }));
    },
  });
  const layer = (name) =>
    createGroundHeights(terrain(name), () => {}, {
      ...manualTimers(),
      gapMs: 100,
    });
  const first = layer('first').place([{ id: 'a', point: [11, 57.1] }]);
  const dropped = layer('dropped');
  dropped.place([{ id: 'b', point: [12, 57.1] }]);
  dropped.cancel();
  await Promise.all([
    first,
    layer('last').place([{ id: 'c', point: [13, 57.1] }]),
  ]);
  assert.deepEqual(
    at.map(([name]) => name),
    ['first', 'last'],
  );
  const apart = at[1][1] - at[0][1];
  // One gap, not the two it would take had the dropped one kept its turn.
  assert.ok(apart >= 90 && apart < 190, `${apart} ms apart`);
});

test('rows of a newer view go before what was left of the older one', async () => {
  const calls = [];
  const first = gate();
  const told = [];
  const timers = manualTimers();
  const ground = createGroundHeights(
    flatTerrain(calls, (call) => (call === 1 ? first.closed : undefined)),
    (ids) => told.push(ids),
    timers,
  );
  // Three requests' worth; the first one is slow.
  const older = ground.place(many(GROUND_CHUNK * 3));
  await moment();
  // The camera moved on meanwhile.
  const newer = ground.place(many(2, 62, 'q'));
  first.open();
  await Promise.all([older, newer]);
  assert.deepEqual(calls, [GROUND_CHUNK, 2], 'the rest was never asked');
  assert.deepEqual(told, [['q0', 'q1']], 'rows that left are not redrawn');
  assert.equal(ground.heightOf('q1'), 40);
  assert.equal(ground.isReal('q1'), true);
  assert.equal(timers.pending.size, 0, 'no back-off for a first lookup');
  // What the slow request brought is kept for when the view comes back.
  await ground.place(many(1));
  assert.equal(ground.heightOf('p0'), 40);
  assert.deepEqual(calls, [GROUND_CHUNK, 2]);
});

test('place resolves when its rows are in, also with a lookup already out', async () => {
  const first = gate();
  const asked = [];
  const terrain = fakeTerrain(
    { 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] },
    asked,
  );
  const ground = createGroundHeights(
    {
      async resolveEllipsoidalGround(coords) {
        if (!asked.length) await first.closed;
        return terrain.resolveEllipsoidalGround(coords);
      },
    },
    () => {},
    manualTimers(),
  );
  ground.place([rows[0]]);
  await moment();
  const second = ground.place(rows);
  first.open();
  await second;
  assert.equal(ground.heightOf('b'), 575);
});

test('rows that left are forgotten; their place is kept for their return', async () => {
  const asked = [];
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] }, asked),
    () => {},
    manualTimers(),
  );
  await ground.place(rows);
  await ground.place([rows[0]]);
  assert.equal(ground.heightOf('b'), 0);
  assert.equal(ground.isReal('b'), false);
  assert.equal(ground.heightOf('a'), 38);
  const back = ground.place(rows);
  assert.equal(ground.heightOf('b'), 575, 'at once, from the kept heights');
  await back;
  assert.equal(asked.length, 2);
});

test('a row that moved under its id is asked again', async () => {
  const asked = [];
  const told = [];
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] }, asked),
    (ids) => told.push(ids),
    manualTimers(),
  );
  await ground.place([{ id: 'a', point: [18.06, 59.33] }]);
  assert.equal(ground.heightOf('a'), 38);
  const moved = ground.place([{ id: 'a', point: [20.22, 67.85] }]);
  assert.equal(ground.heightOf('a'), 0, 'not the old place’s height');
  assert.equal(ground.isReal('a'), false);
  await moved;
  assert.equal(ground.heightOf('a'), 575);
  assert.deepEqual(
    asked.map((c) => c.lat),
    [59.33, 67.85],
  );
  assert.deepEqual(told, [['a'], ['a']]);
});

test('an error in the layer’s own drawing is not a failed lookup', async () => {
  const timers = manualTimers();
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: [38, 'reearth'], 67.85: [575, 'reearth'] }),
    () => {
      throw new Error('draw');
    },
    timers,
  );
  const said = await warnings(() => ground.place(rows));
  assert.equal(said.length, 1);
  assert.equal(said[0][0], '[GroundHeights] redraw failed:');
  assert.equal(ground.heightOf('b'), 575, 'the heights are in place');
  assert.equal(timers.pending.size, 0, 'nothing to ask again');
});

test('a full store drops the place nobody used for the longest', async () => {
  const key = (i) => `60.00000,${(10 + i / 1000).toFixed(5)}`;
  const kept = {};
  for (let i = 0; i < GROUND_STORE_MAX; i++) kept[key(i)] = 100 + i;
  const localStorage = fakeStorage({
    [GROUND_STORE_KEY]: JSON.stringify(kept),
  });
  await withGlobals({ localStorage }, async () => {
    const calls = [];
    const layer = () =>
      createGroundHeights(flatTerrain(calls), () => {}, manualTimers());
    // The oldest place is read, which makes it the newest.
    const reader = layer();
    await reader.place([{ id: 'old', point: [10, 60] }]);
    assert.equal(reader.heightOf('old'), 100);
    assert.deepEqual(calls, []);
    // A new place comes in: one has to go.
    await layer().place([{ id: 'new', point: [5, 55] }]);
    assert.deepEqual(calls, [1]);
    const after = layer();
    await after.place([
      { id: 'old', point: [10, 60] },
      { id: 'new', point: [5, 55] },
    ]);
    assert.deepEqual(calls, [1], 'the place that was read is still kept');
    assert.equal(after.heightOf('old'), 100);
    await after.place([{ id: 'unread', point: [10.001, 60] }]);
    assert.deepEqual(calls, [1, 1], 'the unread one went instead');
  });
});

test('a layer whose rows come and go keeps its heights apart', async () => {
  const calls = [];
  const layer = (passing) =>
    createGroundHeights(flatTerrain(calls), () => {}, {
      ...manualTimers(),
      passing,
    });
  await layer(false).place([rows[0]]);
  assert.deepEqual(calls, [1]);
  // Neither store answers for the other, so neither can push the other out.
  await layer(true).place([rows[0]]);
  assert.deepEqual(calls, [1, 1]);
  await layer(true).place([rows[0]]);
  await layer(false).place([rows[0]]);
  assert.deepEqual(calls, [1, 1], 'each kept its own');
});

test('heights another tab saved are taken over, not overwritten', async () => {
  const listeners = [];
  const addEventListener = (type, listener) => {
    if (type === 'storage') listeners.push(listener);
  };
  await withGlobals(
    { localStorage: fakeStorage(), addEventListener },
    async () => {
      const asked = [];
      const terrain = fakeTerrain({ 59.33: [38, 'reearth'] }, asked);
      await createGroundHeights(terrain, () => {}, manualTimers()).place([
        rows[0],
      ]);
      assert.ok(listeners.length >= 1);
      const newValue = JSON.stringify({
        '67.85000,20.22000': 575,
        '59.33000,18.06000': 999,
      });
      for (const listener of listeners) {
        listener({ key: 'something-else', newValue });
        listener({ key: GROUND_STORE_KEY, newValue });
        listener({ key: GROUND_STORE_KEY, newValue: 'not json' });
        listener({ key: GROUND_STORE_KEY, newValue: null });
      }
      const ground = createGroundHeights(terrain, () => {}, manualTimers());
      await ground.place(rows);
      assert.equal(ground.heightOf('b'), 575, 'the other tab’s place');
      assert.equal(ground.heightOf('a'), 38, 'this tab’s own stays');
      assert.equal(asked.length, 1);
    },
  );
});
