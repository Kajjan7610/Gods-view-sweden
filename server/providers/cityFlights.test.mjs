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
  const flights = createSwedaviaFlights({
    fetchJson,
    now: () => clock,
    env,
    dailyBudget,
  });
  return {
    flights,
    calls,
    advance: (ms) => (clock += ms),
    fail: (message) => (failWith = message),
  };
}

const STOCKHOLM = { latitude: 59.33, longitude: 18.07 };

test('boards and queues per airport, each key on its own service, kept five minutes', async () => {
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
  assert.ok(calls.length > first, 'read again after five minutes');
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
