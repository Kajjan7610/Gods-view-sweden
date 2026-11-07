// The city dossier's flights: the Swedavia airports serving a town, their
// next departures and arrivals, the security queues, the cache and the
// daily allowance of the free subscriptions.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SWEDAVIA_FLIGHTINFO_URL,
  SWEDAVIA_WAITTIME_URL,
  airportsNear,
  createSwedaviaFlights,
  nextDate,
  normalizeFlight,
  normalizeBoard,
  normalizeWaitTimes,
  stockholmDate,
} from './cityFlights.js';

const NOW = Date.parse('2026-11-05T15:00:00Z');
const at = (hhmm) => `2026-11-05T${hhmm}:00Z`;

function departure(id, scheduled, status = {}, times = {}) {
  return {
    flightId: id,
    arrivalAirportSwedish: 'Helsingfors',
    arrivalAirportEnglish: 'Helsinki',
    airlineOperator: { name: 'Finnair' },
    departureTime: { scheduledUtc: at(scheduled), ...times },
    locationAndStatus: {
      terminal: 'T2',
      gate: 'F64',
      flightLegStatus: 'SCH',
      flightLegStatusSwedish: 'Planerad',
      flightLegStatusEnglish: 'Scheduled',
      ...status,
    },
  };
}

test('the airports serving a town: within reach, the busiest first', () => {
  const stockholm = airportsNear({ latitude: 59.33, longitude: 18.07 });
  assert.deepEqual(
    stockholm.map((airport) => airport.iata),
    ['ARN', 'BMA'],
  );
  assert.deepEqual(
    airportsNear({ latitude: 57.71, longitude: 11.97 }).map((a) => a.iata),
    ['GOT'],
  );
  assert.deepEqual(airportsNear({ latitude: 60.67, longitude: 17.14 }), []);
});

test("the Stockholm date turns at the Swedish midnight, not UTC's", () => {
  assert.equal(stockholmDate(Date.parse('2026-11-05T22:30:00Z')), '2026-11-05');
  assert.equal(stockholmDate(Date.parse('2026-11-05T23:30:00Z')), '2026-11-06');
});

test('a board: what has not yet gone, soonest expected first', () => {
  const flights = normalizeBoard(
    [
      {
        flights: [
          departure('AY801', '14:00', {
            flightLegStatus: 'ACT',
            flightLegStatusSwedish: 'Startat',
          }),
          departure('AY802', '15:30', { flightLegStatus: 'DEL' }),
          departure(
            'AY803',
            '15:10',
            {
              flightLegStatus: 'SEQ',
              flightLegStatusSwedish: 'Beräknad 15:50',
              flightLegStatusEnglish: 'Estimated 15:50',
            },
            { estimatedUtc: at('15:50') },
          ),
          departure('AY804', '15:20', {
            flightLegStatus: 'CAN',
            flightLegStatusSwedish: 'Inställt',
            flightLegStatusEnglish: 'Cancelled',
          }),
          departure('AY805', '14:40'),
          departure('AY806', '15:40'),
        ],
      },
      // Tomorrow's list repeats a flight: it shows once.
      { flights: [departure('AY806', '15:40')] },
    ],
    'departures',
    NOW,
  );
  assert.deepEqual(
    flights.map((flight) => flight.flight),
    ['AY804', 'AY806', 'AY803'],
  );
  const late = flights.find((flight) => flight.flight === 'AY803');
  assert.equal(late.delayMinutes, 40);
  assert.deepEqual(late.status, {
    sv: 'Beräknad 15:50',
    en: 'Estimated 15:50',
  });
  assert.deepEqual(late.place, { sv: 'Helsingfors', en: 'Helsinki' });
  assert.equal(late.gate, 'F64');
  assert.equal(flights[0].canceled, true);
});

test('arrivals: landed flights are gone', () => {
  const arrival = (id, status) => ({
    flightId: id,
    departureAirportSwedish: 'Luleå',
    arrivalTime: { scheduledUtc: at('15:30') },
    locationAndStatus: { flightLegStatus: status },
  });
  const flights = normalizeBoard(
    [{ flights: [arrival('SK1', 'LAN'), arrival('SK2', 'SCH')] }],
    'arrivals',
    NOW,
  );
  assert.deepEqual(
    flights.map((flight) => [flight.flight, flight.place]),
    [['SK2', { sv: 'Luleå', en: 'Luleå' }]],
  );
});

test('security queues: ordinary lanes first, by terminal', () => {
  assert.deepEqual(
    normalizeWaitTimes({
      waitTimes: [
        {
          queueName: 'Security Terminal 5F FastTrack',
          terminal: 'T5',
          isFastTrack: true,
          currentProjectedWaitTime: 0,
        },
        {
          queueName: 'Security Terminal 5F',
          terminal: 'T5',
          isFastTrack: false,
          currentProjectedWaitTime: 12.4,
          overflow: true,
        },
        {
          queueName: 'Security Terminal 2',
          terminal: 'T2',
          isFastTrack: false,
          currentProjectedWaitTime: 1,
        },
        { queueName: 'Broken', currentProjectedWaitTime: null },
      ],
    }).map((queue) => [
      queue.terminal,
      queue.minutes,
      queue.fastTrack,
      queue.overflow,
    ]),
    [
      ['T2', 1, false, false],
      ['T5', 12, false, true],
      ['T5', 0, true, false],
    ],
  );
});

function swedavia(env, { failWith = null, dailyBudget } = {}) {
  let clock = NOW;
  const calls = [];
  const fetchJson = async (url, init) => {
    calls.push({ url, key: init.headers['Ocp-Apim-Subscription-Key'] });
    if (failWith) throw new Error(failWith);
    if (url.startsWith(SWEDAVIA_WAITTIME_URL))
      return {
        waitTimes: [
          {
            queueName: 'Security Terminal 5F',
            terminal: 'T5',
            currentProjectedWaitTime: 3,
          },
        ],
      };
    return { flights: [departure('AY900', '16:00')] };
  };
  const service = createSwedaviaFlights({
    fetchJson,
    now: () => clock,
    env,
    dailyBudget,
  });
  return {
    flights: service.nearby,
    service,
    calls,
    advance: (ms) => (clock += ms),
    fail: (message) => (failWith = message),
  };
}

const STOCKHOLM = { latitude: 59.33, longitude: 18.07 };

test('boards and queues per airport, each key on its own service, kept three minutes', async () => {
  const { flights, calls, advance } = swedavia({
    SWEDAVIA_FLIGHTINFO_KEY: 'flight-key',
    SWEDAVIA_WAITTIME_KEY: 'wait-key',
  });
  const airports = await flights(STOCKHOLM);
  assert.deepEqual(
    airports.map((airport) => airport.iata),
    ['ARN', 'BMA'],
  );
  assert.equal(airports[0].departures[0].flight, 'AY900');
  assert.equal(airports[0].security[0].minutes, 3);
  assert.ok(
    calls.every(({ url, key }) =>
      url.startsWith(SWEDAVIA_FLIGHTINFO_URL)
        ? key === 'flight-key'
        : key === 'wait-key',
    ),
  );
  // Early afternoon only today's lists are read.
  assert.ok(calls.every(({ url }) => !url.includes('2026-11-06')));
  const first = calls.length;
  await flights(STOCKHOLM);
  assert.equal(calls.length, first, 'kept');
  advance(6 * 60_000);
  await flights(STOCKHOLM);
  assert.ok(calls.length > first, 'read again after three minutes');
});

test('a failed read falls back on the last board; without keys nothing is asked', async () => {
  const { flights, fail, advance } = swedavia({
    SWEDAVIA_FLIGHTINFO_KEY: 'k',
  });
  const before = await flights(STOCKHOLM);
  assert.equal(before[0].security, null, 'no WaitTime key, no queues');
  fail('upstream HTTP 503');
  advance(6 * 60_000);
  const after = await flights(STOCKHOLM);
  assert.equal(after[0].departures[0].flight, 'AY900');
  const keyless = swedavia({});
  assert.equal(await keyless.flights(STOCKHOLM), null);
  assert.equal(keyless.calls.length, 0);
});

test('the daily allowance stops upstream calls until the Swedish date turns', async () => {
  const { flights, calls, advance } = swedavia(
    { SWEDAVIA_FLIGHTINFO_KEY: 'k' },
    { dailyBudget: 3 },
  );
  const gothenburg = { latitude: 57.71, longitude: 11.97 };
  await flights(gothenburg); // two calls: departures and arrivals
  advance(6 * 60_000);
  const spent = await flights(gothenburg); // one more, then the allowance is used
  assert.equal(calls.length, 3);
  assert.equal(spent[0].departures[0].flight, 'AY900');
  assert.deepEqual(spent[0].arrivals, [], 'the last board instead');
  advance(6 * 60_000);
  await flights(gothenburg);
  assert.equal(calls.length, 3, 'no calls once spent');
  advance(9 * 3600_000); // past the Swedish midnight
  await flights(gothenburg);
  assert.ok(calls.length > 3, 'a new day, a new allowance');
});

test('a board row carries what the airport screens show', () => {
  const row = {
    ...departure('SK1427', '15:30', {
      gateAction: 'B',
      gateActionSwedish: 'Boarding',
      gateActionEnglish: 'Boarding',
      gateOpenUtc: at('15:00'),
      gateCloseUtc: at('15:20'),
    }),
    airlineOperator: { iata: 'SK', name: 'SAS' },
    flightLegIdentifier: {
      callsign: 'SAS1427',
      arrivalAirportIata: 'CPH',
      aircraftRegistration: 'SEROH',
    },
    checkIn: {
      checkInDeskFrom: 71,
      checkInDeskTo: 82,
      checkInStatusSwedish: 'Stängd',
      checkInStatusEnglish: 'Closed',
    },
    codeShareData: ['A31400', 'LH6060'],
    viaDestinations: [{ airportSwedish: 'Visby', airportEnglish: 'Visby' }],
    remarksSwedish: [{ text: 'Gå till gate', indicator: 'POSITIVE' }],
    remarksEnglish: [{ text: 'Go to gate', indicator: 'POSITIVE' }],
    diIndicator: 'S',
  };
  const flight = normalizeFlight(row, 'departures');
  assert.equal(flight.callsign, 'SAS1427');
  assert.equal(flight.placeIata, 'CPH');
  assert.equal(flight.registration, 'SEROH');
  assert.deepEqual(flight.remark, {
    sv: 'Gå till gate',
    en: 'Go to gate',
    tone: 'positive',
  });
  assert.deepEqual(flight.checkIn, {
    from: 71,
    to: 82,
    status: { sv: 'Stängd', en: 'Closed' },
  });
  assert.equal(flight.gateOpen, Date.parse(at('15:00')));
  assert.deepEqual(flight.gateStatus, { sv: 'Boarding', en: 'Boarding' });
  assert.deepEqual(flight.codeshares, ['A31400', 'LH6060']);
  assert.deepEqual(flight.via, [{ sv: 'Visby', en: 'Visby' }]);
  assert.equal(flight.scope, 'S');
  assert.equal(flight.canceled, false);
  const arrival = normalizeFlight(
    {
      flightId: 'SK2',
      departureAirportSwedish: 'Luleå',
      arrivalTime: { scheduledUtc: at('14:00'), actualUtc: at('14:05') },
      locationAndStatus: { flightLegStatus: 'LAN' },
      baggage: { baggageClaimUnit: '2', firstBagUtc: at('14:20') },
      remarksSwedish: [{ text: 'Inställt', indicator: 'NEGATIVE' }],
    },
    'arrivals',
  );
  assert.deepEqual(arrival.baggage, {
    belt: '2',
    first: Date.parse(at('14:20')),
    last: null,
  });
  assert.equal(arrival.actual, Date.parse(at('14:05')));
  assert.equal(arrival.canceled, true, 'a cancellation named in a remark');
  assert.equal(
    normalizeFlight(
      { ...row, locationAndStatus: { flightLegStatus: 'DEL' } },
      'departures',
    ),
    null,
  );
});

test('the next day across month and year ends', () => {
  assert.equal(nextDate('2026-11-30'), '2026-12-01');
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
});

test("the board: the airport's whole day, shared with the dossier's lists", async () => {
  const { service, calls } = swedavia({
    SWEDAVIA_FLIGHTINFO_KEY: 'k',
    SWEDAVIA_WAITTIME_KEY: 'w',
  });
  await service.nearby(STOCKHOLM);
  const before = calls.length;
  const board = await service.board('arn');
  assert.equal(calls.length, before, 'the same day lists, no new calls');
  assert.equal(board.airport.iata, 'ARN');
  assert.equal(board.airport.queues, true);
  assert.equal(board.date, '2026-11-05');
  assert.equal(board.departures[0].flight, 'AY900');
  assert.equal(board.security[0].minutes, 3);
  assert.equal(board.stale, false);
  assert.equal(board.updatedAt, NOW);
  const tomorrow = await service.board('ARN', { date: 'tomorrow' });
  assert.equal(tomorrow.date, '2026-11-06');
  assert.ok(
    calls.some(({ url }) => url.endsWith('/ARN/departures/2026-11-06')),
  );
  const queuesOnly = calls.length;
  const security = await service.board('ARN', { only: 'security' });
  assert.equal(security.departures, null);
  assert.equal(security.security[0].minutes, 3);
  assert.equal(calls.length, queuesOnly);
  assert.equal(await service.board('CPH'), null);
  const visby = await service.board('VBY');
  assert.equal(visby.airport.queues, false);
  assert.equal(visby.security, null);
});

test('a board read out of allowance is the last one, marked stale', async () => {
  const { service, fail, advance } = swedavia({ SWEDAVIA_FLIGHTINFO_KEY: 'k' });
  await service.board('GOT');
  fail('upstream HTTP 503');
  advance(4 * 60_000);
  const board = await service.board('GOT');
  assert.equal(board.stale, true);
  assert.equal(board.updatedAt, NOW);
  assert.equal(board.departures[0].flight, 'AY900');
  const keyless = swedavia({});
  const empty = await keyless.service.board('GOT');
  assert.equal(empty.flights, false);
  assert.equal(empty.departures, null);
  assert.equal(keyless.calls.length, 0);
});

test("the followed aircraft's own rows: by callsign or registration, departure then arrival", async () => {
  const calls = [];
  const leg = (id, callsign, registration, extra) => ({
    ...departure(id, '15:30'),
    flightLegIdentifier: { callsign, aircraftRegistration: registration },
    ...extra,
  });
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/ARN/departures/'))
      return {
        flights: [
          leg('SK1427', 'SAS1427', 'SEROH'),
          leg('DY1', 'NSZ1', 'LNABC'),
        ],
      };
    if (url.includes('/GOT/arrivals/'))
      return {
        flights: [
          {
            flightId: 'SK1427',
            departureAirportSwedish: 'Stockholm',
            arrivalTime: { scheduledUtc: at('16:30') },
            locationAndStatus: { flightLegStatus: 'SCH' },
            flightLegIdentifier: { callsign: 'SAS1427' },
          },
        ],
      };
    return { flights: [] };
  };
  const service = createSwedaviaFlights({
    fetchJson,
    now: () => NOW,
    env: { SWEDAVIA_FLIGHTINFO_KEY: 'k' },
  });
  const legs = await service.findFlight({
    callsign: 'sas 1427',
    airports: ['ESSA', 'got', 'CPH', 'nope'],
  });
  assert.deepEqual(
    legs.map((row) => [row.airport.iata, row.kind, row.flight.flight]),
    [
      ['ARN', 'departures', 'SK1427'],
      ['GOT', 'arrivals', 'SK1427'],
    ],
  );
  assert.equal(
    calls.length,
    4,
    'two airports, two directions; CPH is not Swedavia',
  );
  const byTail = await service.findFlight({ registration: 'LN-ABC' });
  assert.deepEqual(
    byTail.map((row) => row.flight.flight),
    ['DY1'],
    'the kept lists are searched without new calls',
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(await service.findFlight({ callsign: 'NOPE1' }), []);
  // The callsign wins over the airframe's other legs of the day.
  const both = await service.findFlight({
    callsign: 'SAS1427',
    registration: 'LN-ABC',
  });
  assert.deepEqual(
    both.map((row) => row.flight.flight),
    ['SK1427', 'SK1427'],
  );
  assert.equal(await service.findFlight({}), null);
});

test('by registration alone, only the leg under way', async () => {
  const row = (id, hhmm, kind) => ({
    flightId: id,
    [kind === 'departures' ? 'departureTime' : 'arrivalTime']: {
      scheduledUtc: at(hhmm),
    },
    locationAndStatus: { flightLegStatus: 'SCH' },
    flightLegIdentifier: { aircraftRegistration: 'SEROH' },
  });
  const fetchJson = async (url) => ({
    flights: url.includes('/departures/')
      ? [
          row('SK1', '06:00', 'departures'),
          row('SK3', '14:30', 'departures'),
          row('SK5', '18:00', 'departures'),
        ]
      : [row('SK2', '09:00', 'arrivals'), row('SK4', '16:10', 'arrivals')],
  });
  const service = createSwedaviaFlights({
    fetchJson,
    now: () => Date.parse(at('15:00')),
    env: { SWEDAVIA_FLIGHTINFO_KEY: 'k' },
  });
  const legs = await service.findFlight({
    registration: 'SE-ROH',
    airports: ['ARN'],
  });
  assert.deepEqual(
    legs.map((leg) => [leg.kind, leg.flight.flight]),
    [
      ['departures', 'SK3'],
      ['arrivals', 'SK4'],
    ],
  );
});
