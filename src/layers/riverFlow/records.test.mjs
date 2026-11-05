// SMHI river flow: the latest discharge per station, the hour's trend, the
// size classes and the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFlowCard,
  flowClass,
  flowTrend,
  normalizeFlowStations,
  properName,
} from './index.js';

const T = Date.parse('2026-11-05T13:00:00Z');
const station = (key, name, river, lat, lon, values, area = 23100) => ({
  key: String(key),
  name,
  catchmentName: river,
  catchmentSize: area,
  latitude: lat,
  longitude: lon,
  value: values.map((value, i) => ({ date: T + i * 9e5, value, quality: 'O' })),
});

test('stations carry their latest flow and the change over the hour', () => {
  const stations = normalizeFlowStations({
    station: [
      station(
        1583,
        'VÄSTERSEL',
        'MOÄLVEN',
        63.4332,
        18.3034,
        [34.8, 34.6, 34.7, 34.8],
      ),
      station(
        2236,
        'RÄKTFORS',
        'KALIXÄLVEN',
        66.17,
        22.82,
        [300, 305, 311, 317],
      ),
      station(9, 'TOM', 'X', 60, 15, []),
      station(10, 'UTOMLANDS', 'X', 48, 2, [5]),
    ],
  });
  assert.deepEqual(
    stations.map(({ id, name, river, flow, change }) => [
      id,
      name,
      river,
      flow,
      change,
    ]),
    [
      ['2236', 'Räktfors', 'Kalixälven', 317, 17],
      ['1583', 'Västersel', 'Moälven', 34.8, 0],
    ],
  );
  assert.equal(stations[0].updated, T + 3 * 9e5);
  assert.throws(() => normalizeFlowStations({}), /Malformed/);
});

test('names, trends and classes read as people expect', () => {
  assert.equal(properName('PAJALA PUMPHUS'), 'Pajala Pumphus');
  assert.equal(properName('TÄRENDÖ 2'), 'Tärendö 2');
  assert.equal(properName('Already Mixed'), 'Already Mixed');
  assert.equal(flowTrend({ flow: 317, change: 17 }), 'rising');
  assert.equal(flowTrend({ flow: 317, change: -17 }), 'falling');
  assert.equal(flowTrend({ flow: 34.8, change: 0.2 }), 'steady');
  assert.equal(flowTrend({ flow: 5, change: null }), null);
  assert.equal(flowClass(0.5).id, 'brook');
  assert.equal(flowClass(10).id, 'river', 'the upper bound is exclusive');
  assert.equal(flowClass(317).id, 'major');
});

test('the card names the flow, its trend, the river and the time', () => {
  const card = buildFlowCard({
    id: '2236',
    name: 'Räktfors',
    river: 'Kalixälven',
    catchmentKm2: 23103.4,
    point: [22.82, 66.17],
    flow: 317,
    change: 17,
    updated: T,
  });
  assert.equal(card.title, 'RIVER FLOW · RÄKTFORS');
  assert.deepEqual(card.details, [
    '317 m³/s',
    'Rising 17 m³/s over the last hour',
    'Kalixälven · catchment 23,103 km²',
    'Measured 14:00 · SMHI',
  ]);
});
