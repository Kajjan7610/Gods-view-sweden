import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroundHeights, resolveGroundHeights } from './groundHeights.js';

const rows = [
  { id: 'a', point: [18.06, 59.33] },
  { id: 'b', point: [20.22, 67.85] },
];

/** A terrain service answering from a table, counting the points asked. */
function fakeTerrain(table, asked = []) {
  return {
    async resolveEllipsoidalGround(coords) {
      asked.push(...coords);
      return coords.map(({ lat }) =>
        lat in table
          ? { ellipsoid: table[lat], source: 'reearth' }
          : { ellipsoid: null, source: 'unresolved' },
      );
    },
  };
}

test('heights come back by row id; unresolved rows are left out', async () => {
  const heights = await resolveGroundHeights(fakeTerrain({ 59.33: 38 }), rows);
  assert.deepEqual([...heights], [['a', 38]]);
  assert.equal((await resolveGroundHeights(null, rows)).size, 0);
  assert.equal((await resolveGroundHeights(fakeTerrain({}), [])).size, 0);
});

test('a layer asks once per row and redraws when heights arrive', async () => {
  const asked = [];
  let redraws = 0;
  const ground = createGroundHeights(
    fakeTerrain({ 59.33: 38, 67.85: 575 }, asked),
    () => redraws++,
  );
  assert.equal(ground.enabled, true);
  assert.equal(ground.heightOf('a'), 0);
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 38);
  assert.equal(ground.heightOf('b'), 575);
  assert.equal(redraws, 1);
  await ground.place(rows);
  assert.equal(asked.length, 2, 'known rows are not asked again');
  ground.clear();
  assert.equal(ground.heightOf('b'), 0);
});

test('without a terrain service nothing is asked and dots clamp as before', async () => {
  const ground = createGroundHeights(null, () => assert.fail('no redraw'));
  assert.equal(ground.enabled, false);
  await ground.place(rows);
  assert.equal(ground.heightOf('a'), 0);
});

test('a failed lookup leaves the dots where they are', async () => {
  const ground = createGroundHeights(
    {
      async resolveEllipsoidalGround() {
        throw new Error('down');
      },
    },
    () => assert.fail('no redraw'),
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    await ground.place(rows);
  } finally {
    console.warn = warn;
  }
  assert.equal(ground.heightOf('a'), 0);
});
