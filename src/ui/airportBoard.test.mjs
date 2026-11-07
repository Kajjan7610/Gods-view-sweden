// The airport board: its search, tones, "now" line and queue lengths, the
// card offered over an airport, and the board's opening, filtering,
// details, day switch and closing against a stubbed /api/airport-board.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createAirportBoard } from './airportBoard.js';
import {
  airportUnder,
  flightTone,
  matchesQuery,
  nowIndex,
  queueLevel,
} from './airportBoardModel.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const at = (hhmm) => Date.parse(`2026-11-07T${hhmm}:00Z`);

function flight(id, hhmm, extra = {}) {
  return {
    id: `${id}:${at(hhmm)}`,
    flight: id,
    callsign: null,
    airline: 'SAS',
    place: { sv: 'Köpenhamn', en: 'Copenhagen' },
    placeIata: 'CPH',
    via: [],
    codeshares: [],
    planned: at(hhmm),
    expected: at(hhmm),
    actual: null,
    delayMinutes: 0,
    statusCode: 'SCH',
    status: { sv: 'Planerad', en: 'Scheduled' },
    remark: null,
    canceled: false,
    terminal: 'T5',
    gate: 'F39',
    checkIn: null,
    baggage: null,
    scope: 'S',
    ...extra,
  };
}

test('a search matches flight numbers, places in either language and airlines', () => {
  const sas = flight('SK1427', '13:00', {
    codeshares: ['LH6060'],
    via: [{ sv: 'Visby', en: 'Visby' }],
  });
  for (const query of [
    'sk1427',
    'SK 1427',
    'köpen',
    'kopenhamn',
    'copenhagen',
    'cph',
    'sas',
    'lh6060',
    'visby',
    'sas köp',
  ])
    assert.equal(matchesQuery(sas, query), true, query);
  for (const query of ['oslo', 'sk 99', 'sas oslo'])
    assert.equal(matchesQuery(sas, query), false, query);
  assert.equal(matchesQuery(sas, '  '), true);
});

test("a row's tone: cancelled, gone, bad news, good news", () => {
  const kind = 'departures';
  assert.equal(
    flightTone(flight('A', '13:00', { canceled: true }), kind, NOW),
    'canceled',
  );
  assert.equal(
    flightTone(flight('A', '11:00', { statusCode: 'ACT' }), kind, NOW),
    'gone',
  );
  assert.equal(
    flightTone(flight('A', '11:00', { actual: at('11:05') }), kind, NOW),
    'gone',
  );
  assert.equal(
    flightTone(flight('A', '13:00', { delayMinutes: 20 }), kind, NOW),
    'negative',
  );
  assert.equal(
    flightTone(
      flight('A', '13:00', {
        remark: { sv: 'Försenad', en: 'Delayed', tone: 'negative' },
      }),
      kind,
      NOW,
    ),
    'negative',
  );
  assert.equal(
    flightTone(
      flight('A', '12:10', {
        remark: { sv: 'Boarding', en: 'Boarding', tone: 'positive' },
      }),
      kind,
      NOW,
    ),
    'positive',
  );
  assert.equal(
    flightTone(flight('A', '13:00', { delayMinutes: 5 }), kind, NOW),
    'neutral',
  );
  // An arrival is gone once landed.
  assert.equal(
    flightTone(flight('A', '11:00', { statusCode: 'LAN' }), 'arrivals', NOW),
    'gone',
  );
});

test('"now" falls before the first flight scheduled from now on', () => {
  const day = [
    flight('A', '10:00', { statusCode: 'ACT' }),
    flight('B', '11:00', { delayMinutes: 300 }),
    flight('C', '12:00'),
    flight('D', '13:00'),
  ];
  assert.equal(nowIndex(day, NOW), 2);
  assert.equal(nowIndex(day.slice(0, 2), NOW), 2, 'none still to come');
});
test('queue lengths: short, medium, long', () => {
  assert.equal(queueLevel(0), 'short');
  assert.equal(queueLevel(5), 'medium');
  assert.equal(queueLevel(15), 'long');
  assert.equal(
    queueLevel(2, true),
    'long',
    'Swedavia says the queue overflows',
  );
});

test('the airport under the view: near its point and low enough', () => {
  assert.equal(
    airportUnder({ lat: 59.65, lon: 17.93, height: 8000 })?.iata,
    'ARN',
  );
  assert.equal(airportUnder({ lat: 59.65, lon: 17.93, height: 40_000 }), null);
  assert.equal(airportUnder({ lat: 59.33, lon: 18.07, height: 3000 }), null);
  assert.equal(
    airportUnder({ lat: 59.355, lon: 17.94, height: 3000 })?.iata,
    'BMA',
  );
  assert.equal(airportUnder(null), null);
});

function fakeViewer(lat, lon, height) {
  const listeners = [];
  const camera = {
    positionCartographic: { height },
    pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat),
    lat,
    lon,
    moveEnd: {
      addEventListener(fn) {
        listeners.push(fn);
        return () => listeners.splice(listeners.indexOf(fn), 1);
      },
    },
  };
  return {
    camera,
    scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
    settle: () => listeners.forEach((fn) => fn()),
  };
}

const boardBody = (date = '2026-11-07') => ({
  airport: { iata: 'ARN', name: 'Stockholm Arlanda', queues: true },
  date,
  flights: true,
  departures: [
    flight('SK1', '10:00', { statusCode: 'ACT', actual: at('10:05') }),
    flight('SK2', '12:30', {
      delayMinutes: 25,
      expected: at('12:55'),
      remark: {
        sv: 'Försenad till 13:55',
        en: 'Delayed to 13:55',
        tone: 'negative',
      },
      checkIn: { from: 71, to: 82, status: { sv: 'Öppen', en: 'Open' } },
      gateOpen: at('12:00'),
      gateClose: at('12:20'),
      callsign: 'SAS2',
      registration: 'SEROH',
    }),
    flight('DY3', '14:00', {
      airline: 'Norwegian',
      place: { sv: 'Oslo', en: 'Oslo' },
    }),
  ],
  arrivals: [
    flight('SK4', '12:40', { baggage: { belt: '7', first: null, last: null } }),
  ],
  security: [
    {
      id: '5',
      name: 'Security Terminal 2',
      terminal: 'T2',
      fastTrack: false,
      minutes: 3,
      overflow: false,
    },
    {
      id: '6',
      name: 'Security Terminal 2 FastTrack',
      terminal: 'T2',
      fastTrack: true,
      minutes: 0,
      overflow: false,
    },
  ],
  updatedAt: NOW - 60_000,
  stale: false,
  fetchedAt: NOW,
});

function board(viewer = fakeViewer(59.33, 18.07, 3000)) {
  const published = [];
  const urls = [];
  let actions = null;
  const controller = createAirportBoard({
    viewer,
    publish: (view) => published.push(view),
    connect: (next) => ((actions = next), () => {}),
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify(
          boardBody(url.includes('tomorrow') ? '2026-11-08' : '2026-11-07'),
        ),
      );
    },
    now: () => NOW,
    documentRef: null,
  });
  return {
    controller,
    urls,
    act: (name, ...args) => actions[name](...args),
    latest: () => published.at(-1),
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the board opens on a day of rows, "now" before the first to go', async () => {
  const { controller, act, latest, urls } = board();
  act('open', 'arn');
  await settled();
  const view = latest().board;
  assert.equal(urls[0], '/api/airport-board?iata=ARN&date=today');
  assert.equal(view.name, 'Stockholm Arlanda');
  assert.deepEqual(
    view.tabs.map((tab) => tab.id),
    ['departures', 'arrivals', 'security'],
  );
  assert.deepEqual(
    view.rows.map((row) => [row.flight, row.tone, row.nowBefore]),
    [
      ['SK1', 'gone', false],
      ['SK2', 'negative', true],
      ['DY3', 'neutral', false],
    ],
  );
  const late = view.rows[1];
  assert.ok(late.newTime, 'the new time shows beside the old');
  assert.match(late.status, /13:55/);
  assert.equal(late.where, 'T5 · F39');
  controller.destroy();
});

test('search, details, tabs, the day and closing', async () => {
  const { controller, act, latest, urls } = board();
  act('open', 'ARN');
  await settled();
  act('setQuery', 'oslo');
  assert.deepEqual(
    latest().board.rows.map((row) => row.flight),
    ['DY3'],
  );
  act('setQuery', 'nowhere');
  assert.equal(latest().board.rows.length, 0);
  assert.ok(latest().board.empty);
  act('setQuery', '');
  act('toggle', latest().board.rows[1].key);
  const details = latest().board.rows[1].details;
  assert.ok(details.some((item) => item.value === 'SAS2'));
  assert.ok(details.some((item) => /71/.test(item.value)));
  assert.ok(details.some((item) => item.value === 'SEROH'));
  act('setTab', 'arrivals');
  assert.equal(latest().board.rows[0].flight, 'SK4');
  assert.match(latest().board.rows[0].where, /7/);
  act('setTab', 'security');
  const queues = latest().board.rows;
  assert.deepEqual(
    queues.map((row) => [row.level, row.fastTrack]),
    [
      ['short', false],
      ['short', true],
    ],
  );
  act('setTab', 'departures');
  act('setDate', 'tomorrow');
  await settled();
  assert.equal(urls.at(-1), '/api/airport-board?iata=ARN&date=tomorrow');
  assert.equal(
    latest().board.rows.some((row) => row.nowBefore),
    false,
    'no "now" line on tomorrow\'s board',
  );
  act('close');
  assert.equal(latest().board, null);
  controller.destroy();
});

test('an airport without queue readings has no security tab', async () => {
  const { controller, act, latest } = board();
  act('open', 'VBY', 'security');
  await settled();
  assert.equal(latest().board.tab, 'departures');
  assert.deepEqual(
    latest().board.tabs.map((tab) => tab.id),
    ['departures', 'arrivals'],
  );
  act('open', 'CPH');
  assert.equal(latest().board.iata, 'VBY', 'not a Swedavia airport: no change');
  controller.destroy();
});

test('a card is offered over the airport until closed there', async () => {
  const viewer = fakeViewer(59.65, 17.93, 8000);
  const { controller, act, latest } = board(viewer);
  viewer.settle();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(latest().card?.iata, 'ARN');
  act('dismissCard');
  assert.equal(latest().card, null);
  // Flying away and back offers it again.
  viewer.camera.lat = 59.33;
  viewer.camera.lon = 18.07;
  viewer.settle();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(latest().card, null);
  viewer.camera.lat = 59.65;
  viewer.camera.lon = 17.93;
  viewer.settle();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(latest().card?.iata, 'ARN');
  // An open board for the airport replaces its card.
  act('open', 'ARN');
  await settled();
  assert.equal(latest().card, null);
  controller.destroy();
});
