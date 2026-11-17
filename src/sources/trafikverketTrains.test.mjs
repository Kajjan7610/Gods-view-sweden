import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRAFIKVERKET_TRAINS_SHARE_MS,
  foldTrainCalls,
  resetTrainDelays,
  sharedTrainSnapshot,
  trafikverketDelayQuery,
  trafikverketRailVehicles,
  trafikverketTrainQuery,
  trafikverketTrainToVehicle,
  trafikverketTrainsToVehicles,
} from './trafikverketTrains.js';
import { createRailService } from './railService.js';
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
  resetTrainDelays();
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
      origin: null,
      product: null,
      owner: null,
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

// Swedish fork, Rail layer: two trains, one to Oslo (an SJ Snabbtåg) and one
// SL commuter train, each with one station call; Oslo S is in Norway.
const RAIL_CALLED = Date.now() - 5 * 60_000;
const railCall = (train, extra) => ({
  OperationalTrainNumber: train,
  LocationSignature: 'Cst',
  ActivityType: 'Avgang',
  AdvertisedTimeAtLocation: new Date(RAIL_CALLED - 4 * 60_000).toISOString(),
  TimeAtLocation: new Date(RAIL_CALLED).toISOString(),
  ...extra,
});
const RAIL_DELAYS = {
  RESPONSE: {
    RESULT: [
      {
        TrainAnnouncement: [
          railCall('541', {
            FromLocation: [{ LocationName: 'Cst', Priority: 1, Order: 0 }],
            ToLocation: [{ LocationName: 'Ods', Priority: 1, Order: 0 }],
            ProductInformation: [
              { Code: 'PNA054', Description: 'SJ Snabbtåg' },
            ],
            InformationOwner: 'SJ',
          }),
          railCall('2245', {
            FromLocation: [{ LocationName: 'Söc', Priority: 1, Order: 0 }],
            ToLocation: [{ LocationName: 'Mr', Priority: 1, Order: 0 }],
            ProductInformation: [{ Code: 'PNA025', Description: 'Pendeltåg' }],
            InformationOwner: 'SL',
          }),
        ],
      },
      {
        TrainStation: [
          {
            LocationSignature: 'Cst',
            AdvertisedShortLocationName: 'Stockholm C',
            CountryCode: 'SE',
          },
          {
            LocationSignature: 'Ods',
            AdvertisedShortLocationName: 'Oslo S',
            CountryCode: 'NO',
          },
          {
            LocationSignature: 'Mr',
            AdvertisedShortLocationName: 'Märsta',
            CountryCode: 'SE',
          },
        ],
      },
    ],
  },
};
const RAIL_POSITIONS = payload([
  RECORD,
  {
    ...RECORD,
    Train: {
      AdvertisedTrainNumber: '2245',
      OperationalTrainNumber: '2245',
      OperationalTrainDepartureDate: '2026-11-03T00:00:00.000+01:00',
    },
    Position: { WGS84: 'POINT (17.95 59.40)' },
  },
]);

/** A fetch that answers positions and delays, counting each request. */
function railFetch(calls) {
  return async (url, init) => {
    const delays = /TrainAnnouncement/.test(init.body);
    calls.push(delays ? 'delays' : 'positions');
    return Response.json(delays ? RAIL_DELAYS : RAIL_POSITIONS);
  };
}

test('the delay query asks for product, owner and ends, and station countries', () => {
  const query = trafikverketDelayQuery('k', '2026-11-03T18:00:00.000Z', true);
  for (const field of [
    'ProductInformation',
    'InformationOwner',
    'FromLocation',
    'ToLocation',
    'CountryCode',
  ])
    assert.match(query, new RegExp(`<INCLUDE>${field}</INCLUDE>`), field);
  // Still one request with its two queries: no new request type.
  assert.equal(query.match(/<QUERY /g).length, 2);
});

test('a call without a product keeps the one the train already had', () => {
  const byTrain = new Map();
  foldTrainCalls(
    [RAIL_DELAYS.RESPONSE.RESULT[0].TrainAnnouncement[0]],
    byTrain,
  );
  foldTrainCalls(
    [
      railCall('541', {
        TimeAtLocation: new Date(RAIL_CALLED + 60_000).toISOString(),
        LocationSignature: 'U',
      }),
    ],
    byTrain,
  );
  const call = byTrain.get('541');
  assert.equal(call.station, 'U');
  assert.equal(call.product, 'SJ Snabbtåg');
  assert.equal(call.owner, 'SJ');
  assert.equal(call.origin, 'Cst');
});

test('Transit and Rail share one request, and Transit is unchanged', async (t) => {
  resetTrainDelays();
  const calls = [];
  const env = { TRAFIKVERKET_API_KEY: 'secret-key' };
  const transit = createTransitService({ env, fetchImpl: railFetch(calls) });
  const rail = createRailService({ env, fetchImpl: railFetch(calls) });
  t.after(transit.close);
  t.after(rail.close);

  const transitAnswer = await transit.handle(
    request('/api/transit/vehicles/trafikverket-trains'),
  );
  assert.equal(transitAnswer.status, 200);
  const railAnswer = await rail.handle(
    request('/api/rail/trains/trafikverket-trains'),
  );
  assert.equal(railAnswer.status, 200);
  // One positions request and one delay refresh, for both layers.
  assert.deepEqual(calls, ['positions', 'delays']);

  const transitBody = await transitAnswer.json();
  const railBody = await railAnswer.json();
  assert.equal(railBody.fetchedAt, transitBody.fetchedAt);
  // The Transit record has exactly the fields it had before the Rail feed.
  const sj = transitBody.vehicles.find((v) => v.routeId === '541');
  assert.deepEqual(Object.keys(sj).sort(), [
    'bearing',
    'delayMinutes',
    'destination',
    'directionId',
    'id',
    'label',
    'lastStation',
    'lastStationDeparted',
    'lat',
    'lon',
    'occupancy',
    'routeId',
    'speedMps',
    'status',
    'stopId',
    'timestamp',
    'timestampSource',
    'tripId',
  ]);
  assert.equal(sj.label, 'Tåg 541');

  const byRoute = new Map(
    railBody.trains.map((train) => [train.routeId, train]),
  );
  assert.equal(railBody.count, 2);
  assert.equal(railBody.dropped, 0);
  assert.equal(railBody.positions, 'gps');
  const toOslo = byRoute.get('541');
  assert.equal(toOslo.category, 'international', 'ends in Norway');
  assert.equal(toOslo.mode, 'rail');
  assert.equal(toOslo.label, 'SJ Snabbtåg 541');
  assert.equal(toOslo.headsign, 'Oslo S');
  assert.equal(toOslo.delayMinutes, 4);
  assert.equal(toOslo.lastStation, 'Stockholm C');
  assert.equal(toOslo.positionSource, 'gps');
  const commuter = byRoute.get('2245');
  assert.equal(commuter.category, 'local');
  assert.equal(commuter.label, 'Pendeltåg 2245');
  assert.equal(commuter.headsign, 'Märsta');
  assert.equal(JSON.stringify(railBody).includes('secret-key'), false);

  // Within the window, either layer is answered from what is held.
  await rail.handle(request('/api/rail/trains/trafikverket-trains'));
  await transit.handle(request('/api/transit/vehicles/trafikverket-trains'));
  assert.equal(calls.length, 2);
});

test('a snapshot younger than the window answers the other layer', async () => {
  resetTrainDelays();
  const calls = [];
  const fetchImpl = railFetch(calls);
  const positions = () => calls.filter((c) => c === 'positions').length;
  const at = Date.now();
  const first = await sharedTrainSnapshot({ key: 'k', fetchImpl, now: at });
  const again = await sharedTrainSnapshot({
    key: 'k',
    fetchImpl,
    now: at + TRAFIKVERKET_TRAINS_SHARE_MS - 1,
  });
  assert.equal(again, first);
  assert.equal(positions(), 1);
  const vehicles = trafikverketRailVehicles(first);
  assert.equal(vehicles.length, 2);
  assert.ok(vehicles.every((v) => typeof v.abroad === 'boolean'));
  // Two layers asking at once share the request under way.
  resetTrainDelays();
  calls.length = 0;
  await Promise.all([
    sharedTrainSnapshot({ key: 'k', fetchImpl, now: at }),
    sharedTrainSnapshot({ key: 'k', fetchImpl, now: at }),
  ]);
  assert.equal(positions(), 1);
  // Once the window has passed, Trafikverket is asked again.
  await sharedTrainSnapshot({
    key: 'k',
    fetchImpl,
    now: at + TRAFIKVERKET_TRAINS_SHARE_MS,
  });
  assert.equal(positions(), 2);
  // Another key is another snapshot.
  await sharedTrainSnapshot({
    key: 'other',
    fetchImpl,
    now: at + TRAFIKVERKET_TRAINS_SHARE_MS,
  });
  assert.equal(positions(), 3);
});

test('a refused request is not retried by the other layer within the window', async (t) => {
  resetTrainDelays();
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('nope', { status: 401 });
  };
  const env = { TRAFIKVERKET_API_KEY: 'secret-key' };
  const transit = createTransitService({ env, fetchImpl });
  const rail = createRailService({ env, fetchImpl });
  t.after(transit.close);
  t.after(rail.close);
  const one = await transit.handle(
    request('/api/transit/vehicles/trafikverket-trains'),
  );
  const two = await rail.handle(
    request('/api/rail/trains/trafikverket-trains'),
  );
  assert.equal(one.status, 502);
  assert.equal(two.status, 502);
  assert.equal(calls, 1);
});

test('without its key the Rail feed is not offered and never fetches', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('unexpected');
  };
  const keyless = createRailService({ env: {}, fetchImpl });
  t.after(keyless.close);
  const catalog = async (service) =>
    (await (await service.handle(request('/api/rail/feeds'))).json()).feeds;
  assert.equal(
    (await catalog(keyless)).some((f) => f.id === 'trafikverket-trains'),
    false,
  );
  const refused = await keyless.handle(
    request('/api/rail/trains/trafikverket-trains'),
  );
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('x-rail-backoff'), 'not-configured');
  assert.equal(refused.headers.get('retry-after'), '3600');
  assert.equal(calls, 0);

  const keyed = createRailService({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    fetchImpl,
  });
  t.after(keyed.close);
  const listed = (await catalog(keyed)).find(
    (f) => f.id === 'trafikverket-trains',
  );
  assert.ok(listed);
  assert.equal(listed.coverage.length, 3);
  assert.equal(listed.license, 'CC0 1.0');
  // The catalog names neither the key nor its variable.
  const text = JSON.stringify(listed);
  assert.equal(text.includes('secret-key'), false);
  assert.equal(text.includes('TRAFIKVERKET_API_KEY'), false);
  assert.equal(calls, 0);
});
