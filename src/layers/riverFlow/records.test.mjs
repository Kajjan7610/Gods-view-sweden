// SMHI river flow: the latest discharge per station, the hour's trend, the
// size classes and the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLOW_MAX_AGE_MS,
  buildFlowCard,
  flowClass,
  flowTrend,
  flowsOutdated,
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

test('the card names the flow, its trend, the basin and the time', () => {
  const card = buildFlowCard(
    {
      id: '2236',
      name: 'Räktfors',
      river: 'Kalixälven',
      catchmentKm2: 23103.4,
      point: [22.82, 66.17],
      flow: 317,
      change: 17,
      since: T - 45 * 60_000,
      updated: T,
    },
    T + 60 * 60_000,
  );
  assert.equal(card.title, 'RIVER FLOW · RÄKTFORS');
  assert.deepEqual(card.details, [
    '317 m³/s',
    'Rising 17 m³/s since 13:15',
    'Kalixälven · 23,103 km² upstream of the station',
    'Measured 14:00 · SMHI',
  ]);
});

test('a sample without a value or a time is no sample, never 0 m³/s', () => {
  const raw = (value, extra = {}) => ({
    key: '1',
    name: 'A',
    catchmentName: 'X',
    catchmentSize: 5,
    latitude: 60,
    longitude: 15,
    value,
    ...extra,
  });
  const one = (value, extra) =>
    normalizeFlowStations({ station: [raw(value, extra)] })[0];
  // Nothing but empty values: no reading at all.
  for (const empty of [null, '', '  ', undefined])
    assert.equal(one([{ date: T, value: empty, quality: 'O' }]), undefined);
  // SMHI writes "value": null for a station of the set without data.
  assert.equal(one(null), undefined);
  // The hour's last value missing: the one before it stands, nothing falls.
  const row = one([
    { date: T - 9e5, value: 12.5, quality: 'O' },
    { date: T, value: null, quality: 'O' },
  ]);
  assert.deepEqual(
    [row.flow, row.change, row.since, row.updated],
    [12.5, null, null, T - 9e5],
  );
  // A value without a time is not the hour's first sample.
  const dated = one([
    { date: null, value: 99 },
    { date: T - 9e5, value: 12 },
    { date: T, value: 12.5 },
  ]);
  assert.deepEqual(
    [dated.flow, dated.change, dated.since],
    [12.5, 0.5, T - 9e5],
  );
  // A real zero is still a zero.
  assert.equal(one([{ date: T, value: 0 }]).flow, 0);
  // The last sample's quality code and the station's owner come along.
  const owned = one([{ date: T, value: 3, quality: 'O' }], {
    owner: ' Vattenfall ',
  });
  assert.deepEqual([owned.quality, owned.owner], ['O', 'Vattenfall']);
  const plain = one([{ date: T, value: 3, quality: 'X' }]);
  assert.deepEqual([plain.quality, plain.owner], [null, null]);
});

test('the card says since when, what lies upstream and whose value it is', () => {
  // 15:00 in Stockholm on 5 November.
  const NOW = T + 60 * 60_000;
  const row = {
    id: '1',
    name: 'Köpinge',
    river: 'Helge Å',
    catchmentKm2: 1.8,
    point: [14.136, 55.9454],
    flow: 0.62,
    change: -0.05,
    since: T - 45 * 60_000,
    updated: T,
    quality: 'O',
    owner: 'SMHI',
  };
  // The basin's name beside the station's own area, never as its size.
  assert.deepEqual(buildFlowCard(row, NOW).details, [
    '0.62 m³/s',
    'Falling 0.05 m³/s since 13:15',
    'Helge Å · 1.8 km² upstream of the station',
    'Unchecked value',
    'Measured 14:00 · SMHI',
  ]);
  // No basin name: the area alone. An approved value carries no note.
  assert.deepEqual(
    buildFlowCard(
      { ...row, river: null, catchmentKm2: 49.3, quality: 'G', change: 0 },
      NOW,
    ).details,
    [
      '0.62 m³/s',
      'Steady since 13:15',
      '49 km² upstream of the station',
      'Measured 14:00 · SMHI',
    ],
  );
  // Another party's station, roughly checked, last heard the day before.
  const old = buildFlowCard(
    {
      ...row,
      owner: 'Vattenfall',
      quality: 'Y',
      updated: T - 24 * 3_600_000,
      change: null,
      since: null,
    },
    NOW,
  );
  assert.deepEqual(old.details.slice(1), [
    'Helge Å · 1.8 km² upstream of the station',
    'Roughly checked value',
    'Measured 2026-11-04 14:00 · Vattenfall · SMHI',
  ]);
});

test('readings are outdated once even the newest is over three hours old', () => {
  const rows = [{ updated: T - 5 * 3_600_000 }, { updated: T }];
  assert.equal(flowsOutdated(rows, T + FLOW_MAX_AGE_MS), false);
  assert.equal(flowsOutdated(rows, T + FLOW_MAX_AGE_MS + 1), true);
  assert.equal(flowsOutdated([], T), false, 'nothing to judge');
});
