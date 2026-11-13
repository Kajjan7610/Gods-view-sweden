// Trafiklab Realtime departures for the city dossier: the town's stop, the
// local departures, Swedish local times and the call budgets.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRAFIKLAB_REALTIME_API,
  createLocalDepartures,
  normalizeLocalDepartures,
  stockholmLocalMs,
  townStopGroup,
} from './cityLocalTransit.js';

const GAVLE = { latitude: 60.675, longitude: 17.141 };

const stopGroups = {
  stop_groups: [
    {
      id: '740000004',
      name: 'Gävle Centralstation',
      area_type: 'RIKSHALLPLATS',
      average_daily_stop_times: 900,
      transport_modes: ['TRAIN', 'BUS'],
      stops: [{ id: '1', name: 'Gävle C', lat: 60.676, lon: 17.15 }],
    },
    {
      id: '740000100',
      name: 'Gävle Rådhuset',
      area_type: 'META_STOP',
      average_daily_stop_times: 1400,
      transport_modes: ['BUS'],
      stops: [{ id: '2', name: 'Rådhuset', lat: 60.674, lon: 17.142 }],
    },
    {
      id: '740000200',
      name: 'Gävle Godsbangård',
      average_daily_stop_times: 5000,
      transport_modes: ['TRAIN'],
      stops: [{ id: '3', name: 'Godsbangård', lat: 60.68, lon: 17.16 }],
    },
    {
      id: '740000300',
      name: 'Gävlevägen, Uppsala',
      average_daily_stop_times: 9000,
      transport_modes: ['BUS'],
      stops: [{ id: '4', name: 'Gävlevägen', lat: 59.86, lon: 17.64 }],
    },
  ],
};

test("a town's stop is its busiest one with local traffic within reach", () => {
  assert.deepEqual(townStopGroup(stopGroups, GAVLE, 'Gävle'), {
    id: '740000100',
    name: 'Gävle Rådhuset',
  });
  assert.equal(townStopGroup({ stop_groups: [] }, GAVLE, 'Gävle'), null);
  assert.equal(townStopGroup(null, GAVLE, 'Gävle'), null);
  // No stop named after the town: the busiest one within reach.
  assert.equal(townStopGroup(stopGroups, GAVLE, 'Sandviken')?.id, '740000100');
});

test("Trafiklab's local times are Swedish time, summer and winter", () => {
  assert.equal(
    stockholmLocalMs('2026-11-13T14:05:00'),
    Date.parse('2026-11-13T13:05:00Z'),
  );
  assert.equal(
    stockholmLocalMs('2026-07-01T14:05:00'),
    Date.parse('2026-07-01T12:05:00Z'),
  );
  assert.equal(
    stockholmLocalMs('2026-11-13T14:05'),
    Date.parse('2026-11-13T13:05:00Z'),
  );
  assert.equal(stockholmLocalMs('soon'), null);
  assert.equal(stockholmLocalMs(null), null);
});

const departure = (overrides = {}) => ({
  scheduled: '2026-11-13T14:10:00',
  realtime: '2026-11-13T14:10:00',
  delay: 0,
  canceled: false,
  route: {
    designation: '11',
    transport_mode: 'BUS',
    direction: 'Sätra',
    destination: { id: '9', name: 'Sätra centrum' },
  },
  scheduled_platform: { id: 'p', designation: 'B' },
  realtime_platform: null,
  alerts: [],
  ...overrides,
});

test('local departures: no trains, none gone, soonest first, with delay', () => {
  const nowMs = Date.parse('2026-11-13T13:05:00Z');
  const rows = normalizeLocalDepartures(
    {
      departures: [
        departure({
          scheduled: '2026-11-13T14:20:00',
          realtime: '2026-11-13T14:24:00',
          realtime_platform: { id: 'q', designation: 'C' },
          alerts: [{ type: 'OTHER_CAUSE', title: 'Omledning', text: '…' }],
        }),
        departure(),
        departure({
          route: { designation: '42', transport_mode: 'TRAIN' },
        }),
        departure({
          scheduled: '2026-11-13T13:50:00',
          realtime: '2026-11-13T13:50:00',
        }),
        departure({ canceled: 'true', route: { transport_mode: 'TRAM' } }),
        departure({ scheduled: 'x' }),
      ],
    },
    nowMs,
  );
  assert.deepEqual(
    rows.map((row) => [row.line, row.mode, row.delayMinutes, row.canceled]),
    [
      ['11', 'BUS', 0, false],
      [null, 'TRAM', 0, true],
      ['11', 'BUS', 4, false],
    ],
  );
  assert.equal(rows[0].destination, 'Sätra centrum');
  assert.equal(rows[0].platform, 'B');
  assert.equal(rows[2].platform, 'C');
  assert.equal(rows[2].note, 'Omledning');
  assert.deepEqual(normalizeLocalDepartures(null, nowMs), []);
});

test('departures need the key, are cached and keep to the budgets', async () => {
  let at = Date.parse('2026-11-13T13:05:00Z');
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/stops/name/')) return stopGroups;
    return { departures: [departure()] };
  };
  const make = (env, budgets = {}) =>
    createLocalDepartures({ fetchJson, now: () => at, env, ...budgets });
  assert.equal(await make({}).nearby(GAVLE, 'Gävle'), null);
  const local = make({ TRAFIKLAB_REALTIME_KEY: 'k' });
  const first = await local.nearby(GAVLE, 'Gävle');
  assert.equal(first.stop, 'Gävle Rådhuset');
  assert.equal(first.departures.length, 1);
  await local.nearby(GAVLE, 'Gävle');
  assert.equal(calls.length, 2, 'stop and departures cached');
  assert.ok(calls.every((url) => url.startsWith(TRAFIKLAB_REALTIME_API)));
  assert.match(calls[1], /\/departures\/740000100\?key=k$/);
  at += 61_000;
  await local.nearby(GAVLE, 'Gävle');
  assert.equal(calls.length, 3, 'departures read again after a minute');

  const tight = make({ TRAFIKLAB_REALTIME_KEY: 'k' }, { dailyBudget: 1 });
  await assert.rejects(tight.nearby(GAVLE, 'Gävle'), /daily Trafiklab budget/);
  const perMinute = make({ TRAFIKLAB_REALTIME_KEY: 'k' }, { minuteBudget: 1 });
  await assert.rejects(perMinute.nearby(GAVLE, 'Gävle'), /minute budget/);
});
