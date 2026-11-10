import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { redrawEntities } from './redrawEntities.js';

/** What a visualizer would be drawing: the entities it was told about. */
function drawnBy(entities) {
  const drawn = new Map();
  const events = [];
  entities.collectionChanged.addEventListener((_, added, removed) => {
    events.push({ added: added.length, removed: removed.length });
    for (const entity of removed) drawn.delete(entity.id);
    for (const entity of added) drawn.set(entity.id, entity);
  });
  return { drawn, events };
}

const heightOf = (entity) =>
  Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

const dot = (id, height) => ({
  id,
  position: Cesium.Cartesian3.fromDegrees(18.07, 59.33, height),
  point: { pixelSize: 8 },
});

test('a redraw under unchanged ids reaches the visualizers', () => {
  const entities = new Cesium.EntityCollection();
  const { drawn, events } = drawnBy(entities);
  redrawEntities(entities, () => {
    entities.add(dot('a', 0));
    entities.add(dot('b', 0));
  });
  redrawEntities(entities, () => {
    entities.add(dot('a', 161.2));
    entities.add(dot('b', 38.1));
  });
  assert.equal(drawn.get('a'), entities.getById('a'));
  assert.equal(drawn.get('b'), entities.getById('b'));
  assert.ok(Math.abs(heightOf(drawn.get('a')) - 161.2) < 0.01);
  // The first draw, then one removal and one addition for the redraw.
  assert.deepEqual(events, [
    { added: 2, removed: 0 },
    { added: 0, removed: 2 },
    { added: 2, removed: 0 },
  ]);
});

test('Cesium drops a same-id replacement made inside one suspension', () => {
  // The behaviour redrawEntities works around; if Cesium changes it, the
  // helper can go back to one suspension around both.
  const entities = new Cesium.EntityCollection();
  const { drawn } = drawnBy(entities);
  entities.add(dot('a', 0));
  entities.suspendEvents();
  entities.removeAll();
  entities.add(dot('a', 161.2));
  entities.resumeEvents();
  assert.notEqual(drawn.get('a'), entities.getById('a'));
});

test('a draw that throws leaves the collection reporting again', () => {
  const entities = new Cesium.EntityCollection();
  const { events } = drawnBy(entities);
  assert.throws(() =>
    redrawEntities(entities, () => {
      entities.add(dot('a', 0));
      throw new Error('bad row');
    }),
  );
  entities.add(dot('b', 0));
  assert.deepEqual(events, [
    { added: 1, removed: 0 },
    { added: 1, removed: 0 },
  ]);
});

test('the callback gets the collection it draws into', () => {
  const entities = new Cesium.EntityCollection();
  redrawEntities(entities, (target) => target.add(dot('a', 0)));
  assert.equal(entities.values.length, 1);
});
