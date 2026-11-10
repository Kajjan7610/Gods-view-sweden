// The city dossier's live transport: the town's station, its departures
// and the jams around it, with either part absent without its key.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOMTOM_INCIDENTS_URL,
  boxAround,
  cityTransitProxy,
  departuresQuery,
  normalizeDepartures,
  normalizeJams,
  normalizeStations,
  townStation,
} from './cityTransit.js';
import { TRAFIKVERKET_API_URL } from './trafikverketProxy.js';

const stationPayload = {
  RESPONSE: {
    RESULT: [
      {
        TrainStation: [
          {
            LocationSignature: 'Cst',
            AdvertisedLocationName: 'Stockholm C',
            Geometry: { WGS84: 'POINT (18.0579 59.3302)' },
          },
          {
            LocationSignature: 'Sci',
            AdvertisedLocationName: 'Stockholm City',
            Geometry: { WGS84: 'POINT (18.0596 59.3317)' },
          },
          {
            LocationSignature: 'Gä',
            AdvertisedLocationName: 'Gävle C',
            Geometry: { WGS84: 'POINT (17.1518 60.6761)' },
          },
          {
            LocationSignature: 'Su',
            AdvertisedLocationName: 'Sundsvall C',
            Geometry: { WGS84: 'POINT (17.3066 62.3866)' },
          },
          { LocationSignature: 'X', AdvertisedLocationName: 'Utan plats' },
        ],
      },
    ],
  },
};

test("a town's station is its central station within reach", () => {
  const stations = normalizeStations(stationPayload);
  assert.equal(stations.length, 4);
  const at = (latitude, longitude) => ({ latitude, longitude });
  assert.equal(
    townStation(stations, at(59.3317, 18.0596), 'Stockholm').name,
    'Stockholm C',
  );
  assert.equal(
    townStation(stations, at(60.67, 17.14), 'Gävle').name,
    'Gävle C',
  );
  assert.equal(
    townStation(stations, at(60.67, 17.14), 'Annat namn').name,
    'Gävle C',
  );
  assert.equal(townStation(stations, at(64.0, 15.0), 'Ingenstans'), null);
});

test('departures: still to leave, with destination names, delay and reason', () => {
  const now = Date.parse('2026-11-05T19:00:00+01:00');
  const row = (ident, planned, extra = {}) => ({
    AdvertisedTrainIdent: ident,
    AdvertisedTimeAtLocation: planned,
    ToLocation: [{ LocationName: 'Su', Order: 0 }],
    ProductInformation: [{ Description: 'SJ Snabbtåg' }],
    TrackAtLocation: '3',
    ...extra,
  });
  const departures = normalizeDepartures(
    {
      RESPONSE: {
        RESULT: [
          {
            TrainAnnouncement: [
              row('1', '2026-11-05T18:40:00+01:00', {
                TimeAtLocation: '2026-11-05T18:41:00+01:00',
              }),
              row('2', '2026-11-05T18:45:00+01:00', {
                EstimatedTimeAtLocation: '2026-11-05T19:42:00+01:00',
                Deviation: [{ Description: 'Signalfel' }],
              }),
              row('3', '2026-11-05T18:50:00+01:00'),
              row('4', '2026-11-05T19:10:00+01:00', {
                Canceled: true,
                ToLocation: [{ LocationName: 'Okänd' }],
              }),
            ],
          },
        ],
      },
    },
    new Map([['Su', 'Sundsvall C']]),
    now,
  );
  assert.deepEqual(
    departures.map(({ train, delayMinutes, destination, canceled, note }) => [
      train,
      delayMinutes,
      destination,
      canceled,
      note,
    ]),
    [
      ['2', 57, 'Sundsvall C', false, 'Signalfel'],
      ['4', 0, 'Okänd', true, null],
    ],
  );
  assert.equal(departures[0].track, '3');
  const bus = normalizeDepartures(
    {
      RESPONSE: {
        RESULT: [
          {
            TrainAnnouncement: [
              row('5', '2026-11-05T19:20:00+01:00', { TrackAtLocation: 'x' }),
            ],
          },
        ],
      },
    },
    new Map(),
    now,
  );
  assert.equal(bus[0].track, null, 'a replacement bus has no track');
  const query = departuresQuery('k"ey', 'Gä', now);
  assert.match(query, /authenticationkey="k&quot;ey"/);
  assert.match(query, /<EQ name="LocationSignature" value="Gä" \/>/);
  assert.match(query, /orderby="AdvertisedTimeAtLocation"/);
});

test('jams: the longest delays first, roads and stretch named', () => {
  const jams = normalizeJams({
    incidents: [
      {
        properties: {
          iconCategory: 6,
          delay: 98,
          length: 2171.7,
          roadNumbers: ['E20', 'E4'],
          from: 'Gröndal',
          to: 'Nyboda',
          events: [{ description: 'Långsam trafik' }],
          magnitudeOfDelay: 1,
        },
      },
      {
        properties: {
          iconCategory: 6,
          delay: 400,
          length: 900,
          roadNumbers: [],
          from: 'A',
          to: 'B',
          events: [{ description: 'Kö' }],
        },
      },
      { properties: { iconCategory: 8, delay: 999 } },
    ],
  });
  assert.deepEqual(
    jams.map(({ roads, delaySeconds, lengthM }) => [
      roads,
      delaySeconds,
      lengthM,
    ]),
    [
      [[], 400, 900],
      [['E20', 'E4'], 98, 2172],
    ],
  );
  const box = boxAround({ latitude: 60, longitude: 17 }, 12)
    .split(',')
    .map(Number);
  assert.ok(Math.abs(box[3] - box[1] - 0.2156) < 0.001);
  assert.ok(
    box[2] - box[0] > box[3] - box[1],
    'longitude span is wider in the north',
  );
});

function route(options, path = '/api/city-transit') {
  const handlers = new Map();
  cityTransitProxy(options).configureServer({
    middlewares: { use: (at, fn) => handlers.set(at, fn) },
  });
  const handler = handlers.get(path);
  return async (url) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
}

test('the route answers trains and jams, each only with its key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url === TRAFIKVERKET_API_URL && /TrainStation/.test(init.body))
      return new Response(JSON.stringify(stationPayload));
    if (url === TRAFIKVERKET_API_URL)
      return new Response(
        JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: [] }] } }),
      );
    if (url.startsWith(TOMTOM_INCIDENTS_URL))
      return new Response(JSON.stringify({ incidents: [] }));
    return new Response('', { status: 404 });
  };
  const keyed = route({
    fetchImpl,
    env: { TRAFIKVERKET_API_KEY: 'a', TOMTOM_API_KEY: 'b' },
  });
  const body = (await keyed('/?lat=60.67&lon=17.14&town=G%C3%A4vle')).body;
  assert.equal(body.trains.station, 'Gävle C');
  assert.deepEqual(body.jams, { items: [] });
  await keyed('/?lat=60.67&lon=17.14&town=G%C3%A4vle');
  assert.equal(
    calls.filter((url) => url === TRAFIKVERKET_API_URL).length,
    2,
    'stations and departures cached',
  );
  const keyless = route({ fetchImpl, env: {} });
  const none = (await keyless('/?lat=60.67&lon=17.14')).body;
  assert.equal(none.trains, null);
  assert.equal(none.jams, null);
  assert.equal(none.flights, null);
  assert.equal((await keyless('/?lat=x')).status, 400);
});

test('the airport board route: one Swedavia airport, today or tomorrow', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ flights: [] }));
  };
  const board = route(
    { fetchImpl, env: { SWEDAVIA_FLIGHTINFO_KEY: 'k' } },
    '/api/airport-board',
  );
  const today = await board('/?iata=ARN');
  assert.equal(today.status, 200);
  assert.equal(today.body.airport.name, 'Stockholm Arlanda');
  assert.deepEqual(today.body.departures, []);
  assert.equal(today.body.security, null, 'no WaitTime key');
  assert.equal(calls.length, 2);
  assert.equal((await board('/?iata=CPH')).status, 404);
  assert.equal((await board('/?iata=ARN&only=security')).body.departures, null);
  assert.equal(calls.length, 2, 'queues alone ask no flight list');
});

import { departuresQuery as queryFor } from './cityTransit.js';

test('a late train is still asked for; one that has left is not', () => {
  const query = queryFor('k', 'Gä', Date.parse('2026-11-05T12:11:00Z'));
  // Due 12:00 and expected 12:25: too old by its advertised time, not by
  // the time it is expected.
  assert.ok(
    query.includes(
      '<OR>' +
        '<GT name="AdvertisedTimeAtLocation" value="2026-11-05T12:01:00.000Z" />' +
        '<GT name="EstimatedTimeAtLocation" value="2026-11-05T12:01:00.000Z" />' +
        '</OR>',
    ),
  );
  assert.ok(
    query.includes(
      '<LT name="AdvertisedTimeAtLocation" value="2026-11-05T15:11:00.000Z" />',
    ),
  );
  assert.ok(query.includes('<EXISTS name="TimeAtLocation" value="false" />'));
});

test('the keys are not spent outside Sweden', async () => {
  const calls = [];
  const keyed = route({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ incidents: [] }));
    },
    env: { TOMTOM_API_KEY: 'b' },
  });
  // New York, and a request without a place (read as 0, 0).
  assert.equal((await keyed('/?lat=40.71&lon=-74.01')).status, 400);
  assert.equal((await keyed('/')).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await keyed('/?lat=59.33&lon=18.07')).status, 200);
  assert.equal(calls.length, 1);
});

test('an answer without stations is not kept for a day', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let empty = true;
  const keyed = route({
    fetchImpl: async (url, init) => {
      if (/TrainStation/.test(init?.body ?? ''))
        return new Response(
          JSON.stringify(
            empty
              ? { RESPONSE: { RESULT: [{ TrainStation: [] }] } }
              : stationPayload,
          ),
        );
      return new Response(
        JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: [] }] } }),
      );
    },
    env: { TRAFIKVERKET_API_KEY: 'a' },
  });
  const first = (await keyed('/?lat=60.67&lon=17.14&town=G%C3%A4vle')).body;
  assert.equal(first.trains.error, true);
  // The next request asks again, and the town has its station.
  empty = false;
  const second = (await keyed('/?lat=60.67&lon=17.14&town=G%C3%A4vle')).body;
  assert.equal(second.trains.station, 'Gävle C');
});
