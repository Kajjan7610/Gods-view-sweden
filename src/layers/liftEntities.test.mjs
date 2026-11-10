import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { liftEntities } from './liftEntities.js';

const heightOf = (entity) =>
  Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

const at = (height) => Cesium.Cartesian3.fromDegrees(18.07, 59.33, height);

const dot = (id, height) => ({
  id: `dot:${id}`,
  position: at(height),
  point: { pixelSize: 8 },
});

/** A collection with dots a, b and c at height 0, and what it reported. */
function drawn() {
  const entities = new Cesium.EntityCollection();
  for (const id of ['a', 'b', 'c']) entities.add(dot(id, 0));
  const events = [];
  entities.collectionChanged.addEventListener(
    (_, added, removed, changed) => {
      events.push({
        added: added.length,
        removed: removed.length,
        changed: changed.map((entity) => entity.id).sort(),
      });
    },
  );
  return { entities, events };
}

test('dots move where they are; nothing is removed or added', () => {
  const { entities, events } = drawn();
  const before = ['a', 'b', 'c'].map((id) => entities.getById(`dot:${id}`));
  const heights = new Map([
    ['a', 161.2],
    ['b', 38.1],
  ]);
  const moved = liftEntities(
    entities,
    ['a', 'b'],
    (id) => `dot:${id}`,
    (id) => at(heights.get(id)),
  );
  assert.equal(moved, 2);
  assert.deepEqual(
    ['a', 'b', 'c'].map((id) => entities.getById(`dot:${id}`)),
    before,
    'the same entities are still there',
  );
  assert.ok(Math.abs(heightOf(before[0]) - 161.2) < 0.01);
  assert.ok(Math.abs(heightOf(before[1]) - 38.1) < 0.01);
  assert.ok(Math.abs(heightOf(before[2])) < 0.01, 'c was not asked to move');
  // Both moves reach the visualizers as one change.
  assert.deepEqual(events, [
    { added: 0, removed: 0, changed: ['dot:a', 'dot:b'] },
  ]);
});

test('a row that is not drawn, or has no place, is skipped', () => {
  const { entities, events } = drawn();
  const asked = [];
  const moved = liftEntities(
    entities,
    ['gone', 'a', 'b'],
    (id) => `dot:${id}`,
    (id) => {
      asked.push(id);
      return id === 'a' ? null : at(12);
    },
  );
  assert.equal(moved, 1);
  assert.deepEqual(asked, ['a', 'b'], 'no position is built for a missing dot');
  assert.ok(Math.abs(heightOf(entities.getById('dot:a'))) < 0.01);
  assert.ok(Math.abs(heightOf(entities.getById('dot:b')) - 12) < 0.01);
  assert.deepEqual(events, [{ added: 0, removed: 0, changed: ['dot:b'] }]);
});

test('no rows is no event; an error still lets events through again', () => {
  const { entities, events } = drawn();
  assert.equal(
    liftEntities(entities, [], (id) => id, () => at(1)),
    0,
  );
  assert.deepEqual(events, []);
  assert.throws(() =>
    liftEntities(
      entities,
      ['a'],
      (id) => `dot:${id}`,
      () => {
        throw new Error('no position');
      },
    ),
  );
  entities.add(dot('d', 0));
  assert.deepEqual(events, [{ added: 1, removed: 0, changed: [] }]);
});
