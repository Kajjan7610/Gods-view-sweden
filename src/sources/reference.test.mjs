import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceSources } from './reference.js';
import { createStandaloneReferenceSources } from '../standalone/layerSources.js';

test('reference factories retain compatibility without starting acquisition or sharing instances', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('unexpected acquisition');
  });
  assert.equal(createReferenceSources, createStandaloneReferenceSources);
  const first = createReferenceSources();
  const second = createReferenceSources();
  assert.deepEqual(Object.keys(first), [
    'earthquakes',
    'air-quality',
    'fire-perimeters',
    'drone-airspace',
    'wildlife-sightings',
    'cables',
    'gnss-integrity',
    'trafikverket-roads',
    'trafikverket-weather',
    'smhi-warnings',
    'polisen-events',
    'electricity-prices',
    'power-grid',
    'transit-alerts',
    'sr-traffic',
    'sea-weather',
    'company-stores',
    'lightning-strikes',
    'fire-stations',
    'police-stations',
    'shelters',
    'hospitals',
    'municipalities',
    'election-districts',
    'protected-nature',
    'heritage-remains',
    'speed-cameras',
    'river-flow',
    'gamma-radiation',
    'road-ferries',
    'aurora',
    'smhi-weather',
  ]);
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first['air-quality'], second['air-quality']);
  assert.notEqual(first['fire-perimeters'], second['fire-perimeters']);
  assert.notEqual(first['drone-airspace'], second['drone-airspace']);
  assert.notEqual(first['wildlife-sightings'], second['wildlife-sightings']);
  assert.notEqual(first.cables, second.cables);
  assert.notEqual(first['gnss-integrity'], second['gnss-integrity']);
  assert.notEqual(first['trafikverket-roads'], second['trafikverket-roads']);
  assert.notEqual(
    first['trafikverket-weather'],
    second['trafikverket-weather'],
  );
  assert.notEqual(first['smhi-warnings'], second['smhi-warnings']);
  assert.notEqual(first['polisen-events'], second['polisen-events']);
  assert.notEqual(first['electricity-prices'], second['electricity-prices']);
  assert.notEqual(first['sr-traffic'], second['sr-traffic']);
  assert.notEqual(first['sea-weather'], second['sea-weather']);
  assert.notEqual(first.aurora, second.aurora);
  assert.notEqual(first['smhi-weather'], second['smhi-weather']);
  assert.notEqual(first['power-grid'], second['power-grid']);
  assert.notEqual(first['transit-alerts'], second['transit-alerts']);
  assert.notEqual(first['gamma-radiation'], second['gamma-radiation']);
  assert.notEqual(first['road-ferries'], second['road-ferries']);
  assert.notEqual(first['river-flow'], second['river-flow']);
  assert.notEqual(first['speed-cameras'], second['speed-cameras']);
  assert.notEqual(first['fire-stations'], second['fire-stations']);
  assert.notEqual(first['lightning-strikes'], second['lightning-strikes']);
  assert.notEqual(first['company-stores'], second['company-stores']);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first['air-quality'].getSnapshot, 'function');
  assert.equal(typeof first['fire-perimeters'].getSnapshot, 'function');
  assert.equal(typeof first['drone-airspace'].getSnapshot, 'function');
  assert.equal(typeof first['wildlife-sightings'].getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(typeof first['gnss-integrity'].getSnapshot, 'function');
  assert.equal(requests, 0);
});
