import assert from 'node:assert/strict';
import test from 'node:test';

import {
  trafikverketTrainQuery,
  trafikverketTrainToVehicle,
  trafikverketTrainsToVehicles,
} from './trafikverketTrains.js';
import { createTransitService } from './transitService.js';
import {
  getTransitFeed,
  transitFeedsInRange,
  transitModeResolved,
} from '../data/transitFeeds.js';

// Shaped like a live `TrainPosition` record (schema 1.1), trimmed to INCLUDE.
const RECORD = {
  Train: {
    AdvertisedTrainNumber: '541',
    OperationalTrainNumber: '541',
    OperationalTrainDepartureDate: '2026-11-03T00:00:00.000+01:00',
  },
  Position: { WGS84: 'POINT (18.0586 59.3299)' },
  Bearing: 184,
  Speed: 72,
  TimeStamp: '2026-11-03T19:40:12.000+01:00',
  Status: { Active: true },
  Deleted: false,
};
const payload = (records) => ({
  RESPONSE: { RESULT: [{ TrainPosition: records }] },
});
const request = (path) => ({
  url: `https://example.test${path}`,
  method: 'GET',
});

test('a TrainPosition record becomes a rail vehicle record', () => {
  const vehicle = trafikverketTrainToVehicle(RECORD);
  assert.deepEqual(vehicle, {
    id: '541-20261103',
    lat: 59.3299,
    lon: 18.0586,
    bearing: 184,
    speedMps: 20,
    timestamp: Date.parse('2026-11-03T19:40:12.000+01:00') / 1000,
    routeId: '541',
    tripId: '541-20261103',
    directionId: null,
    label: 'Tåg 541',
    stopId: null,
    status: null,
    occupancy: null,
  });
});

test('inactive, deleted, unpositioned and unnumbered trains are dropped', () => {
  for (const patch of [
    { Deleted: true },
    { Status: { Active: false } },
    { Position: { WGS84: 'POINT (0 0)' } },
    { Position: {} },
    { Train: { OperationalTrainNumber: 'not a number!' } },
    { Train: {} },
  ]) {
    assert.equal(
      trafikverketTrainToVehicle({ ...RECORD, ...patch }),
      null,
      JSON.stringify(patch),
    );
  }
});

test('missing bearing and speed stay unknown rather than zero', () => {
  const vehicle = trafikverketTrainToVehicle({
    ...RECORD,
    Bearing: undefined,
    Speed: null,
  });
  assert.equal(vehicle.bearing, null);
  assert.equal(vehicle.speedMps, null);
});

test('duplicate reports keep the newest, and an ERROR result throws', () => {
  const older = { ...RECORD, TimeStamp: '2026-11-03T19:30:00.000+01:00' };
  const { vehicles, entityCount } = trafikverketTrainsToVehicles(
    payload([older, RECORD]),
  );
  assert.equal(entityCount, 2);
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].timestamp, Date.parse(RECORD.TimeStamp) / 1000);
  assert.throws(
    () =>
      trafikverketTrainsToVehicles({
        RESPONSE: {
          RESULT: [
            {
              ERROR: { SOURCE: 'Security', MESSAGE: 'Invalid authentication' },
            },
          ],
        },
      }),
    (error) =>
      /Invalid authentication/.test(error.message) &&
      error.upstreamStatus === 401,
  );
});

test('the query escapes the key and asks only for recent positions', () => {
  const body = trafikverketTrainQuery('a"b<c', '2026-11-03T18:30:00.000Z');
  assert.match(body, /authenticationkey="a&quot;b&lt;c"/);
  assert.match(body, /objecttype="TrainPosition"/);
  assert.match(
    body,
    /<GT name="TimeStamp" value="2026-11-03T18:30:00.000Z" \/>/,
  );
});

test('the feed is registered as rail and covers Sweden end to end', () => {
  const feed = getTransitFeed('trafikverket-trains');
  assert.ok(feed);
  assert.equal(feed.defaultMode, 'rail');
  // Resolved, not defaulted: trains get the rail speed ceiling.
  assert.equal(transitModeResolved(feed, '541'), true);
  for (const [name, lat, lon] of [
    ['Trelleborg', 55.375, 13.157],
    ['Göteborg', 57.71, 11.97],
    ['Strömstad', 58.94, 11.17],
    ['Stockholm', 59.33, 18.07],
    ['Sveg', 62.03, 14.36],
    ['Storlien', 63.32, 12.1],
    ['Östersund', 63.18, 14.64],
    ['Kiruna', 67.85, 20.22],
    ['Riksgränsen', 68.43, 18.13],
    ['Haparanda', 65.84, 24.14],
  ]) {
    assert.ok(
      transitFeedsInRange(lat, lon).some((f) => f.id === feed.id),
      name,
    );
  }
  for (const [name, lat, lon] of [
    ['Oslo', 59.91, 10.75],
    ['Helsinki', 60.17, 24.94],
    ['Trondheim', 63.43, 10.4],
  ]) {
    assert.equal(
      transitFeedsInRange(lat, lon).some((f) => f.id === feed.id),
      false,
      name,
    );
  }
});

test('without a key the proxy answers "not configured" and never fetches', async (t) => {
  let calls = 0;
  t.mock.method(console, 'warn', () => {});
  const service = createTransitService({
    env: {},
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  const response = await service.handle(
    request('/api/transit/vehicles/trafikverket-trains'),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-transit-backoff'), 'not-configured');
  assert.equal((await response.json()).retryInSec, 3600);
  assert.equal(calls, 0);
});

test('with a key the proxy POSTs the query and serves vehicles', async (t) => {
  const calls = [];
  const service = createTransitService({
    env: { TRAFIKVERKET_API_KEY: ' secret-key ' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(payload([RECORD]));
    },
  });
  t.after(service.close);
  const response = await service.handle(
    request('/api/transit/vehicles/trafikverket-trains'),
  );
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.feedId, 'trafikverket-trains');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.vehicles[0].label, 'Tåg 541');
  assert.equal(snapshot.vehicles[0].timestampSource, 'vehicle');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /authenticationkey="secret-key"/);
  assert.equal(JSON.stringify(snapshot).includes('secret-key'), false);
  // Served from the 15 s cache: no second upstream request.
  await service.handle(request('/api/transit/vehicles/trafikverket-trains'));
  assert.equal(calls.length, 1);
});

test('Trafiklab feeds send their key as ?key= and cover their own county', async (t) => {
  const calls = [];
  const service = createTransitService({
    env: { TRAFIKLAB_GTFS_RT_KEY: 'rt-key' },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response('', { status: 503 });
    },
  });
  t.mock.method(console, 'warn', () => {});
  t.after(service.close);
  await service.handle(request('/api/transit/vehicles/trafiklab-sl'));
  assert.equal(
    calls[0],
    'https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=rt-key',
  );
  const keyless = createTransitService({ env: {} });
  t.after(keyless.close);
  const response = await keyless.handle(
    request('/api/transit/vehicles/trafiklab-skane'),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-transit-backoff'), 'not-configured');

  const ids = (lat, lon) =>
    transitFeedsInRange(lat, lon)
      .map((f) => f.id)
      .filter((id) => id.startsWith('trafiklab-'));
  assert.deepEqual(ids(59.33, 18.07), ['trafiklab-sl'], 'Stockholm');
  assert.deepEqual(ids(59.86, 17.64), ['trafiklab-ul'], 'Uppsala');
  assert.deepEqual(ids(55.6, 13.0), ['trafiklab-skane'], 'Malmö');
  assert.deepEqual(ids(58.41, 15.62), ['trafiklab-otraf'], 'Linköping');
  assert.deepEqual(
    ids(57.71, 11.97),
    [],
    'Göteborg (Västtrafik has no positions)',
  );
});

test('a refused key is a 502 with a cooldown, and the key is never logged', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const service = createTransitService({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    fetchImpl: async () => new Response('nope', { status: 401 }),
  });
  t.after(service.close);
  const response = await service.handle(
    request('/api/transit/vehicles/trafikverket-trains'),
  );
  assert.equal(response.status, 502);
  assert.ok(lines.length >= 1);
  assert.equal(
    lines.some((line) => line.includes('secret-key')),
    false,
  );
});
