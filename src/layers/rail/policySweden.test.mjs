// Swedish fork: the Rail card of a Trafikverket train. Trafikverket gives no
// timetable pack, so the card says how late the train was at its last
// station call, in the Transit card's words (the same catalog entries).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRailSelectionCopy } from './policy.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const feed = getRegisteredRailFeed('trafikverket-trains');
const t = (text, values) =>
  `T(${String(text).replace(/\{(\w+)\}/g, (m, key) =>
    values && key in values ? String(values[key]) : m,
  )})`;
const train = {
  id: '541-20261117',
  routeId: '541',
  label: 'SJ InterCity 541',
  headsign: 'Gävle C',
  lat: 59.86,
  lon: 17.64,
  timestamp: Math.floor(NOW / 1000) - 20,
  timestampSource: 'vehicle',
  category: 'national',
  mode: 'rail',
  positionSource: 'gps',
  delayMinutes: 4,
  lastStation: 'Uppsala C',
  lastStationDeparted: true,
};

test('the card names the destination and the delay at the last call', () => {
  const copy = buildRailSelectionCopy(feed, train, NOW, NOW, null, t);
  assert.equal(copy.title, '🚆 T(Route 541) · T(To Gävle C)');
  assert.deepEqual(copy.details, [
    'T(National rail) · T(Train) · Trafikverket · Sweden',
    'T(Live GPS)',
    'T(4 min late) · T(departed Uppsala C)',
    'T(Reported 20 s ago)',
    'T(Vehicle 541-20261117) · SJ InterCity 541',
  ]);
});

test('early, on time, standing at a station, and no delay known', () => {
  const line = (record) =>
    buildRailSelectionCopy(feed, { ...train, ...record }, NOW, NOW, null, t)
      .details[2];
  assert.equal(
    line({ delayMinutes: -2, lastStationDeparted: false }),
    'T(2 min early) · T(at Uppsala C)',
  );
  assert.equal(line({ delayMinutes: 0, lastStation: null }), 'T(On time)');
  assert.equal(
    line({ delayMinutes: undefined }),
    'T(Reported 20 s ago)',
    'no delay line',
  );
});

test('timetable stops, when a feed has them, take the place of the line', () => {
  const stops = [
    {
      stopId: 'U',
      name: 'Uppsala C',
      lat: 59.858,
      lon: 17.646,
      state: 'passed',
      atStop: false,
      expectedArrival: '11:58',
      expectedDeparture: '11:59',
      relative: 'T+1',
    },
    {
      stopId: 'Tie',
      name: 'Tierp',
      lat: 60.343,
      lon: 17.516,
      state: 'next',
      atStop: false,
      expectedArrival: '12:15',
      expectedDeparture: '12:16',
      relative: 'T−15',
    },
  ];
  const copy = buildRailSelectionCopy(feed, train, NOW, NOW, null, t, {
    stops,
  });
  assert.ok(copy.details.some((line) => line.startsWith('T(Next Tierp')));
  assert.ok(!copy.details.some((line) => line.includes('T(departed ')));
});
