// Trafikverket's road ferries: routes, departures, messages and statuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEPARTURES_PER_ROUTE,
  ferryMessages,
  normalizeDeparture,
  normalizeFerrySnapshot,
  pointOf,
} from './records.js';
import { buildFerryCard, departureLine } from './cards.js';

const NOW = Date.parse('2026-11-13T13:25:00Z');
const at = (clock) => `2026-11-13T${clock}:00.000+01:00`;

const payload = {
  RESPONSE: {
    RESULT: [
      {
        FerryRoute: [
          {
            Id: 6,
            Name: 'Ammeröleden',
            Shortname: 'FolAm',
            DeviationId: 'STANDING_6',
            Geometry: { WGS84: 'POINT (15.2987884807903 62.8286460021305)' },
            Type: { Name: 'Vändande' },
            Harbor: [
              { Name: 'Stavre', SortOrder: 20 },
              { Name: 'Ammer', SortOrder: 10 },
            ],
          },
          {
            Id: 30,
            Name: 'Holmöleden',
            DeviationId: 'HOLMON_STOP',
            Geometry: { WGS84: 'POINT (20.818 63.838)' },
            Harbor: [{ Name: 'Holmön' }, { Name: 'Norrfjärden' }],
          },
          {
            Id: 40,
            Name: 'Högsäterleden',
            Geometry: { WGS84: 'POINT (12.81 59.349)' },
          },
          { Id: 41, Name: 'Utanför', Geometry: { WGS84: 'POINT (2 48)' } },
          { Id: 42, Name: 'Borttagen', Deleted: true },
        ],
      },
      {
        FerryAnnouncement: [
          ...['14:30', '15:00', '15:30', '16:00', '16:30'].map((clock) => ({
            DepartureTime: at(clock),
            FromHarbor: { Name: 'Ammer' },
            ToHarbor: { Name: 'Stavre' },
            Route: { Id: 6 },
          })),
          {
            DepartureTime: at('14:20'),
            FromHarbor: { Name: 'Ammer' },
            ToHarbor: { Name: 'Stavre' },
            Route: { Id: 6 },
          },
          {
            DepartureTime: at('14:45'),
            FromHarbor: { Name: 'Holmön' },
            ToHarbor: { Name: 'Norrfjärden' },
            Info: ['Kallelsetur – ring 0771-65 65 65'],
            DeviationId: 'HOLMON_CALL',
            Route: { Id: 30 },
          },
          { DepartureTime: 'x', Route: { Id: 6 } },
        ],
      },
      {
        Situation: [
          {
            Deviation: [
              // The standing deviation every route has: its name only.
              { Id: 'STANDING_6', Header: 'Ammeröleden' },
              {
                Id: 'HOLMON_STOP',
                Header: 'Holmöleden',
                Message: 'All färjetrafik är inställd på grund av hårt väder.',
              },
            ],
          },
        ],
      },
    ],
  },
};

test('a WKT point inside Sweden, nothing else', () => {
  assert.deepEqual(pointOf('POINT (17.5 59.4)'), [17.5, 59.4]);
  assert.equal(pointOf('POINT (2 48)'), null);
  assert.equal(pointOf(''), null);
});

test('only a deviation with a message is a message', () => {
  const messages = ferryMessages(payload.RESPONSE.RESULT[2].Situation);
  assert.equal(messages.has('STANDING_6'), false);
  assert.match(messages.get('HOLMON_STOP'), /inställd/);
});

test('departures: gone ones and those beyond three hours are left out', () => {
  assert.equal(
    normalizeDeparture({ DepartureTime: at('14:20') }, NOW),
    null,
    'five minutes gone',
  );
  assert.equal(
    normalizeDeparture({ DepartureTime: at('17:30') }, NOW),
    null,
    'beyond three hours',
  );
  assert.equal(normalizeDeparture({ Deleted: true }, NOW), null);
  assert.equal(normalizeDeparture({ DepartureTime: at('14:24') }, NOW)?.at, NOW - 60_000);
});

test('routes with their next departures, messages and status', () => {
  const { routes } = normalizeFerrySnapshot(payload, NOW);
  assert.deepEqual(
    routes.map((route) => [route.name, route.status]),
    [
      ['Ammeröleden', 'running'],
      ['Holmöleden', 'message'],
      ['Högsäterleden', 'idle'],
    ],
  );
  const ammer = routes[0];
  assert.equal(ammer.departures.length, DEPARTURES_PER_ROUTE);
  assert.deepEqual(ammer.harbors, ['Ammer', 'Stavre']);
  assert.deepEqual(ammer.point, [15.2987884807903, 62.8286460021305]);
  assert.deepEqual(ammer.messages, []);
  const holmon = routes[1];
  assert.equal(holmon.messages.length, 1);
  assert.deepEqual(holmon.departures[0].info, ['Kallelsetur – ring 0771-65 65 65']);
  assert.deepEqual(normalizeFerrySnapshot(null, NOW), { routes: [] });
});

test('the card lists the message first, then the next departures', () => {
  const { routes } = normalizeFerrySnapshot(payload, NOW);
  const card = buildFerryCard(routes[1]);
  assert.match(card.title, /HOLMÖLEDEN/);
  assert.match(card.details[1], /inställd/);
  assert.equal(
    departureLine(routes[1].departures[0]),
    '14:45 Holmön → Norrfjärden · Kallelsetur – ring 0771-65 65 65',
  );
  const idle = buildFerryCard(routes[2]);
  assert.ok(idle.details.some((line) => /three hours/.test(line)));
});
