// Swedish fork: Trafikverket's railway disruptions (OperativeEvent 1.0 in
// namespace ols.open, stations from TrainStation 1.4) for the Rail layer.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAIL_DISRUPTIONS_REFRESH_MS,
  RAIL_DISRUPTIONS_STALE_MAX_MS,
  createRailDisruptionsService,
  normalizeRailDisruptions,
  railDisruptionStations,
  swedishPoint,
  trafikverketRailDisruptionsQuery,
} from './trafikverketRailDisruptions.js';

const NOW = Date.parse('2026-11-17T12:00:00+01:00');
const at = (clock) => `2026-11-17T${clock}:00.000+01:00`;

// Shaped like the API's answer: OperativeEvent records as the schema
// documents them, then the station list.
const ELFEL = {
  OperativeEventId: 'O261117-001',
  CountyNo: [13],
  EventType: { Description: 'Kontaktledning', EventTypeCode: '22' },
  StartDateTime: at('09:12'),
  EventState: 1,
  EventTrafficType: 0,
  Geometry: {
    SWEREF99TM: 'POINT (350000 6370000)',
    WGS84: 'POINT (57.41649262674987 12.590308752374316)',
  },
  ModifiedDateTime: at('11:30'),
  EventSection: [
    {
      FromLocation: { Signature: 'Bs', CountryCode: 'SE' },
      ToLocation: { Signature: 'Vb', CountryCode: 'SE' },
    },
  ],
  TrafficImpact: [
    {
      Id: 'TI1',
      StartDateTime: at('09:20'),
      EndDateTime: at('14:00'),
      ForecastType: 'TRAFIKPÅVERKAN',
      ModifiedDateTime: at('11:40'),
      PublicMessage: {
        Header: 'Elfel: Borås-Varberg',
        Description:
          'Inga tåg kan köra mellan Borås och Varberg på grund av ett elfel. Ersättningsbussar är beställda.',
        StartDateTime: at('09:25'),
        EndDateTime: '2026-11-18T09:25:00.000+01:00',
        ModifiedDateTime: at('11:45'),
      },
      SelectedSection: [
        {
          FromLocation: { Signature: 'Bs', CountryCode: 'SE' },
          ToLocation: { Signature: 'Vb', CountryCode: 'SE' },
          OperatingLevel: 4,
          SectionLocation: [
            {
              Signature: 'Vb',
              CountryCode: 'SE',
              Affected: true,
              PossibleTravelerExchange: true,
              LocationOrder: 9,
            },
            {
              Signature: 'Bs',
              CountryCode: 'SE',
              Affected: true,
              PossibleTravelerExchange: true,
              LocationOrder: 0,
            },
            {
              Signature: 'Rda',
              CountryCode: 'SE',
              Affected: true,
              PossibleTravelerExchange: false,
              LocationOrder: 2,
            },
            {
              Signature: 'Kia',
              CountryCode: 'SE',
              Affected: true,
              PossibleTravelerExchange: true,
              LocationOrder: 3,
            },
            {
              Signature: 'Hrl',
              CountryCode: 'SE',
              Affected: false,
              PossibleTravelerExchange: true,
              LocationOrder: 12,
            },
          ],
        },
      ],
      Version: 3,
    },
  ],
  Version: 5,
  Deleted: false,
};
/** No public message yet, and stations the list does not place. */
const VAGNFEL = {
  OperativeEventId: 'O261117-002',
  EventType: { Description: 'Dragfordon/motorvagn', EventTypeCode: '34' },
  StartDateTime: at('11:34'),
  EventState: 1,
  Geometry: { WGS84: 'POINT (58.032754279468094 13.03712996111264)' },
  ModifiedDateTime: at('11:50'),
  EventSection: [
    {
      FromLocation: { Signature: 'Hpbg', CountryCode: 'SE' },
      ToLocation: { Signature: 'Fby', CountryCode: 'SE' },
    },
  ],
  Deleted: false,
};
const ENDED = {
  ...VAGNFEL,
  OperativeEventId: 'O261117-003',
  EndDateTime: at('11:00'),
};
const PLANNED = {
  ...VAGNFEL,
  OperativeEventId: 'O261117-004',
  StartDateTime: at('22:00'),
};
const CLOSED = { ...VAGNFEL, OperativeEventId: 'O261117-005', EventState: 0 };
const REMOVED = { ...VAGNFEL, OperativeEventId: 'O261117-006', Deleted: true };
const NORWAY = {
  OperativeEventId: 'O261117-007',
  EventType: { Description: 'Spårfel', EventTypeCode: '40' },
  StartDateTime: at('08:00'),
  EventState: 1,
  Geometry: { WGS84: 'POINT (68.44 17.43)' },
  EventSection: [
    {
      FromLocation: { Signature: 'Nk', CountryCode: 'NO' },
      ToLocation: { Signature: 'Bjf', CountryCode: 'NO' },
    },
  ],
};
const STATIONS = [
  {
    LocationSignature: 'Bs',
    AdvertisedLocationName: 'Borås C',
    CountryCode: 'SE',
    Geometry: { WGS84: 'POINT (12.936944 57.721)' },
  },
  {
    LocationSignature: 'Kia',
    AdvertisedLocationName: 'Kinna',
    CountryCode: 'SE',
    Geometry: { WGS84: 'POINT (12.6929 57.5097)' },
  },
  {
    LocationSignature: 'Rda',
    AdvertisedLocationName: 'Rydal',
    CountryCode: 'SE',
    Geometry: { WGS84: 'POINT (12.69 57.56)' },
  },
  {
    LocationSignature: 'Vb',
    AdvertisedLocationName: 'Varberg',
    CountryCode: 'SE',
    Geometry: { WGS84: 'POINT (12.2508 57.1072)' },
  },
  {
    LocationSignature: 'Hrl',
    AdvertisedLocationName: 'Horred',
    CountryCode: 'SE',
    Geometry: { WGS84: 'POINT (12.47 57.35)' },
  },
  {
    LocationSignature: 'Nk',
    AdvertisedLocationName: 'Narvik',
    CountryCode: 'NO',
    Geometry: { WGS84: 'POINT (17.43 68.44)' },
  },
];
const EVENTS = [ELFEL, VAGNFEL, ENDED, PLANNED, CLOSED, REMOVED, NORWAY];
const answer = (withStations = true) => ({
  RESPONSE: {
    RESULT: [
      { OperativeEvent: EVENTS },
      ...(withStations ? [{ TrainStation: STATIONS }] : []),
    ],
  },
});

test('the query asks for ongoing operative events, and stations when told', () => {
  const plain = trafikverketRailDisruptionsQuery('k"<&', false);
  assert.match(plain, /authenticationkey="k&quot;&lt;&amp;"/);
  assert.match(
    plain,
    /<QUERY objecttype="OperativeEvent" namespace="ols\.open" schemaversion="1\.0" limit="500">/,
  );
  assert.match(plain, /<EQ name="EventState" value="1" \/>/);
  assert.match(plain, /<EQ name="Deleted" value="false" \/>/);
  assert.doesNotMatch(plain, /TrainStation/);
  const daily = trafikverketRailDisruptionsQuery('k', true);
  assert.match(daily, /objecttype="TrainStation" schemaversion="1\.4"/);
  assert.match(daily, /<EQ name="CountryCode" value="SE" \/>/);
  assert.match(daily, /<INCLUDE>Geometry\.WGS84<\/INCLUDE>/);
});

test('points are read either way round, and only inside Sweden', () => {
  assert.deepEqual(swedishPoint('POINT (12.9369 57.721)'), {
    lat: 57.721,
    lon: 12.9369,
  });
  // An operative event's centre has been seen latitude first.
  assert.deepEqual(swedishPoint('POINT (57.4165 12.5903)'), {
    lat: 57.4165,
    lon: 12.5903,
  });
  assert.equal(swedishPoint('POINT (10.75 59.91)'), null, 'Oslo');
  assert.equal(swedishPoint('nonsense'), null);
});

test('stations: Swedish ones by signature, with name and place', () => {
  const stations = railDisruptionStations(STATIONS);
  assert.deepEqual(stations.get('Bs'), {
    name: 'Borås C',
    lat: 57.721,
    lon: 12.936944,
  });
  assert.equal(stations.has('Nk'), false, 'Narvik is not Swedish');
});

test('ongoing events are placed on the stations with passenger exchange they affect', () => {
  const stations = railDisruptionStations(STATIONS);
  const { disruptions, places } = normalizeRailDisruptions(
    EVENTS,
    stations,
    NOW,
  );
  assert.deepEqual(
    disruptions.map((record) => record.id),
    ['O261117-002', 'O261117-001'],
    'newest first; ended, planned, closed, deleted and Norwegian left out',
  );
  const elfel = disruptions.find((record) => record.id === 'O261117-001');
  assert.deepEqual(elfel, {
    id: 'O261117-001',
    reason: 'Kontaktledning',
    header: 'Elfel: Borås-Varberg',
    description:
      'Inga tåg kan köra mellan Borås och Varberg på grund av ett elfel. Ersättningsbussar är beställda.',
    stretch: 'Borås C – Varberg',
    stations: ['Borås C', 'Kinna', 'Varberg'],
    moreStations: 0,
    start: Date.parse(at('09:12')),
    end: Date.parse(at('14:00')),
    endKind: 'impact',
    resumption: null,
    updated: Date.parse(at('11:45')),
  });
  assert.deepEqual(
    places.map((place) => [place.id, place.name, place.disruptions]),
    [
      ['Bs', 'Borås C', ['O261117-001']],
      ['Kia', 'Kinna', ['O261117-001']],
      ['Vb', 'Varberg', ['O261117-001']],
      // No station of its own placed: Trafikverket's centre for the event.
      ['e:O261117-002', 'Hpbg – Fby', ['O261117-002']],
    ],
  );
  const centre = places.at(-1);
  assert.equal(centre.lat, 58.032754279468094);
  assert.equal(centre.lon, 13.03712996111264);
  const vagnfel = disruptions[0];
  assert.equal(vagnfel.header, null, 'no public message');
  assert.equal(vagnfel.reason, 'Dragfordon/motorvagn');
  assert.equal(vagnfel.end, null);
});

test('a forecast that is not the end of the impact says so; a withdrawn message is not shown', () => {
  const stations = railDisruptionStations(STATIONS);
  const impact = ELFEL.TrafficImpact[0];
  const event = {
    ...ELFEL,
    RailRoadTimeForServiceResumption: at('15:30'),
    TrafficImpact: [
      {
        ...impact,
        ForecastType: 'TID TILL PROGNOS',
        PublicMessage: { ...impact.PublicMessage, EndDateTime: at('11:00') },
      },
    ],
  };
  const [record] = normalizeRailDisruptions([event], stations, NOW).disruptions;
  assert.equal(record.endKind, 'forecast');
  assert.equal(record.header, null);
  assert.equal(record.description, null);
  assert.equal(record.resumption, Date.parse(at('15:30')));
  // No affected station: the ends of the stretch stand for it.
  const ends = normalizeRailDisruptions(
    [{ ...ELFEL, TrafficImpact: [] }],
    stations,
    NOW,
  );
  assert.deepEqual(
    ends.places.map((place) => place.id),
    ['Bs', 'Vb'],
  );
});

/** A fetch that answers from a script and records each request. */
function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    const next = script(calls.length);
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response('{}', { status: next });
    return new Response(JSON.stringify(next));
  };
  return { calls, fetchImpl };
}

function quiet(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  return logs;
}

test('one request per two minutes, shared by every viewer', async (t) => {
  const logs = quiet(t);
  let clock = NOW;
  const { calls, fetchImpl } = fakeFetch((n) => answer(n === 1));
  const service = createRailDisruptionsService({
    fetchImpl,
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
  });
  const [a, b] = await Promise.all([service.handle(), service.handle()]);
  assert.equal(calls.length, 1, 'viewers asking together share one request');
  assert.equal(a.status, 200);
  assert.equal(a.body, b.body);
  assert.equal(
    calls[0].url,
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
  );
  assert.match(calls[0].body, /TrainStation/, 'stations on the first ask');
  const body = JSON.parse(a.body);
  assert.equal(body.disruptions.length, 2);
  assert.equal(body.stale, false);
  assert.equal(a.headers['Cache-Control'], 'no-store');

  clock += RAIL_DISRUPTIONS_REFRESH_MS - 1;
  await service.handle();
  assert.equal(calls.length, 1, 'still the cached snapshot');
  clock += 1;
  const later = await service.handle();
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].body, /TrainStation/, 'stations once a day');
  assert.equal(JSON.parse(later.body).places.length, 4, 'stations kept');
  assert.ok(
    logs.every((line) => !line.includes('secret-key')),
    'the key is never logged',
  );
  assert.ok(
    !a.body.includes('secret-key') && !later.body.includes('secret-key'),
  );
});

test('a failure is held for two minutes; the last snapshot is served stale', async (t) => {
  quiet(t);
  let clock = NOW;
  let fail = false;
  const { calls, fetchImpl } = fakeFetch(() => (fail ? 500 : answer()));
  const service = createRailDisruptionsService({
    fetchImpl,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    now: () => clock,
  });
  await service.handle();
  fail = true;
  clock += RAIL_DISRUPTIONS_REFRESH_MS;
  const stale = await service.handle();
  assert.equal(calls.length, 2);
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(stale.body).stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  clock += RAIL_DISRUPTIONS_REFRESH_MS - 1;
  await service.handle();
  assert.equal(calls.length, 2, 'the failure is held');
  clock += RAIL_DISRUPTIONS_STALE_MAX_MS;
  const gone = await service.handle();
  assert.equal(calls.length, 3);
  assert.equal(gone.status, 502, 'too old to show');
});

test('a first failure answers 502 and is not retried for two minutes', async (t) => {
  quiet(t);
  let clock = NOW;
  const { calls, fetchImpl } = fakeFetch(() => ({
    RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'Invalid authentication' } }] },
  }));
  const service = createRailDisruptionsService({
    fetchImpl,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    now: () => clock,
  });
  assert.equal((await service.handle()).status, 502);
  clock += 60_000;
  assert.equal((await service.handle()).status, 502);
  assert.equal(calls.length, 1);
});

test('without the key Trafikverket is never contacted', async (t) => {
  const logs = quiet(t);
  const { calls, fetchImpl } = fakeFetch(() => answer());
  const service = createRailDisruptionsService({ fetchImpl, env: {} });
  const first = await service.handle();
  await service.handle();
  assert.equal(first.status, 503);
  assert.equal(JSON.parse(first.body).error, 'not_configured');
  assert.equal(calls.length, 0);
  assert.equal(
    logs.filter((line) => line.includes('TRAFIKVERKET_API_KEY')).length,
    1,
    'said once',
  );
  assert.equal((await service.handle({ method: 'POST' })).status, 405);
});
