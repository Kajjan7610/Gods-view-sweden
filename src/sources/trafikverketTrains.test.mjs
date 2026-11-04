import assert from 'node:assert/strict';
import test from 'node:test';

import {
  foldTrainCalls,
  resetTrainDelays,
  trafikverketDelayQuery,
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
// Station calls (TrainAnnouncement 1.9) and the station list (TrainStation 1.4).
// The call is ten minutes old: calls older than three hours are forgotten.
const CALLED = Date.now() - 10 * 60_000;
const DELAYS = {
  RESPONSE: {
    RESULT: [
      {
        TrainAnnouncement: [
          {
            OperationalTrainNumber: '541',
            LocationSignature: 'Cst',
            ActivityType: 'Avgang',
            AdvertisedTimeAtLocation: new Date(
              CALLED - 7 * 60_000,
            ).toISOString(),
            TimeAtLocation: new Date(CALLED).toISOString(),
            ToLocation: [{ LocationName: 'U', Priority: 1, Order: 0 }],
          },
        ],
      },
      {
        TrainStation: [
          {
            LocationSignature: 'Cst',
            AdvertisedShortLocationName: 'Stockholm C',
          },
          { LocationSignature: 'U', AdvertisedShortLocationName: 'Uppsala C' },
        ],
      },
    ],
  },
};
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
  resetTrainDelays();
  const calls = [];
  const service = createTransitService({
    env: { TRAFIKVERKET_API_KEY: ' secret-key ' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        /TrainAnnouncement/.test(init.body) ? DELAYS : payload([RECORD]),
      );
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
  // The second POST is the delay refresh, joined on the train number.
  assert.equal(calls.length, 2);
  assert.equal(snapshot.vehicles[0].delayMinutes, 7);
  assert.equal(snapshot.vehicles[0].lastStation, 'Stockholm C');
  assert.equal(snapshot.vehicles[0].destination, 'Uppsala C');
  assert.equal(
    calls[0].url,
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /authenticationkey="secret-key"/);
  assert.equal(JSON.stringify(snapshot).includes('secret-key'), false);
  // Served from the 15 s cache: no second upstream request.
  await service.handle(request('/api/transit/vehicles/trafikverket-trains'));
  assert.equal(calls.length, 2);
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

test('station calls fold into the newest call per train, with its delay', () => {
  const byTrain = new Map();
  foldTrainCalls(
    [
      {
        OperationalTrainNumber: '541',
        LocationSignature: 'Sod',
        ActivityType: 'Ankomst',
        AdvertisedTimeAtLocation: '2026-11-03T19:20:00+01:00',
        TimeAtLocation: '2026-11-03T19:23:00+01:00',
      },
      {
        OperationalTrainNumber: '541',
        LocationSignature: 'Cst',
        ActivityType: 'Avgang',
        AdvertisedTimeAtLocation: '2026-11-03T19:30:00+01:00',
        TimeAtLocation: '2026-11-03T19:28:00+01:00',
        ToLocation: [{ LocationName: 'U', Order: 0 }],
      },
      { OperationalTrainNumber: '9', TimeAtLocation: 'never' },
    ],
    byTrain,
  );
  assert.deepEqual([...byTrain.keys()], ['541']);
  assert.deepEqual(
    { ...byTrain.get('541'), at: undefined },
    {
      at: undefined,
      delayMinutes: -2,
      station: 'Cst',
      departed: true,
      destination: 'U',
    },
  );
  const query = trafikverketDelayQuery('k"', '2026-11-03T18:00:00.000Z', true);
  assert.match(query, /authenticationkey="k&quot;"/);
  assert.match(query, /objecttype="TrainAnnouncement"/);
  assert.match(query, /objecttype="TrainStation"/);
  assert.doesNotMatch(
    trafikverketDelayQuery('k', '2026-11-03T18:00:00.000Z', false),
    /TrainStation/,
  );
});
