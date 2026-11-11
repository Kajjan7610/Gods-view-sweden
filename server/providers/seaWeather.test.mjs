import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SMHI_SEA_URL,
  VIVA_URL,
  seaWeatherFromSmhi,
  seaWeatherProxy,
} from './seaWeather.js';

const LIST = {
  GetStationsResult: {
    Stations: [
      { ID: 114, Name: 'Vinga', Lat: 57.632, Lon: 11.6047 },
      { ID: 21, Name: 'Ale', Lat: 65.5698, Lon: 22.1721 },
      { ID: 99, Name: 'Trasig', Lat: 59, Lon: 18 },
    ],
  },
};
const sample = (Name, Value) => ({
  Name,
  Value,
  Updated: '2026-11-04 22:45:00',
  Quality: 'Ok',
});

function harness(options) {
  let route;
  let handler;
  seaWeatherProxy(options).configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async () => {
    const res = {
      destroyed: false,
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

function viva(urls, { down = new Set() } = {}) {
  return async (url) => {
    urls.push(String(url));
    const id = String(url).slice(VIVA_URL.length);
    if (!id) return Response.json(LIST);
    if (down.has(id)) return new Response('down', { status: 500 });
    return Response.json({
      GetSingleStationResult: {
        ID: Number(id),
        Samples:
          id === '114'
            ? [sample('Medelvind', 'SV 6.7'), sample('Vattenstånd', '-18')]
            : [sample('Vattenstånd', '12')],
      },
    });
  };
}

test('one refresh walks the stations; a silent station is counted, not fatal', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  let clock = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: viva(urls, { down: new Set(['99']) }),
  });
  assert.equal(request.route(), '/api/sea-weather');
  const body = (await request()).json();
  assert.deepEqual(
    body.stations.map((row) => [row.name, row.meanWind, row.level]),
    [
      ['Ale', null, 12],
      ['Vinga', 6.7, -18],
    ],
  );
  assert.equal(body.failed, 1);
  assert.equal(urls.length, 4, 'the list plus three stations');
  clock += 5 * 60_000;
  await request();
  assert.equal(urls.length, 4, 'cached for ten minutes');
  clock += 6 * 60_000;
  await request();
  assert.equal(urls.length, 7, 'stations again; the list is kept a day');
});

test('a failure serves the last stations marked stale, then gives up', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = 0;
  let fail = false;
  const urls = [];
  const ok = viva(urls);
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) =>
      fail ? new Response('down', { status: 503 }) : ok(url),
  });
  await request();
  fail = true;
  clock += 11 * 60_000;
  assert.equal((await request()).json().stale, true);
  clock += 3 * 60 * 60_000;
  assert.equal((await request()).status, 502);
});

// The samples are stamped 22:45 Swedish time on 4 November.
const SAMPLED = Date.parse('2026-11-04T21:45:00Z');

test('a station that falls silent keeps its last values while they are current', async (t) => {
  t.mock.method(console, 'log', () => {});
  const down = new Set();
  let clock = SAMPLED + 60_000;
  let vingaMeasured = '2026-11-04 22:45:00';
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      const id = String(url).slice(VIVA_URL.length);
      if (!id) return Response.json(LIST);
      if (down.has(id)) return new Response('down', { status: 500 });
      return Response.json({
        GetSingleStationResult: {
          ID: Number(id),
          Samples: [
            {
              ...sample('Vattenstånd', '12'),
              Updated: id === '114' ? vingaMeasured : '2026-11-04 22:45:00',
            },
          ],
        },
      });
    },
  });
  assert.equal((await request()).json().stations.length, 3);
  // Trasig does not answer the next walk: still there, and counted.
  down.add('99');
  clock += 11 * 60_000;
  const second = (await request()).json();
  assert.deepEqual(
    second.stations.map((row) => row.name),
    ['Ale', 'Trasig', 'Vinga'],
  );
  assert.equal(second.failed, 1);
  assert.equal(second.stale, undefined);
  // Three hours after it measured, its values are no longer the weather;
  // Vinga has measured anew and Ale has fallen silent too.
  clock = SAMPLED + 3 * 60 * 60_000 + 60_000;
  vingaMeasured = '2026-11-05 01:45:00';
  down.add('21');
  const third = (await request()).json();
  assert.deepEqual(
    third.stations.map((row) => row.name),
    ['Vinga'],
  );
  assert.equal(third.failed, 2);
});

test('after a walk where nobody answered ViVa is left alone for five minutes', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const urls = [];
  let clock = SAMPLED + 60_000;
  let fail = false;
  const ok = viva(urls);
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      if (!fail) return ok(url);
      urls.push(String(url));
      return new Response('down', { status: 503 });
    },
  });
  await request();
  assert.equal(urls.length, 4);
  // Every station is silent: the rows kept from last time are not an answer.
  fail = true;
  clock += 11 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(urls.length, 7);
  // Within five minutes: the last stations again, no new walk.
  clock += 4 * 60_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(urls.length, 7);
  // After them one more walk; and once ViVa answers, fresh again.
  clock += 61_000;
  fail = false;
  const back = (await request()).json();
  assert.equal(urls.length, 10);
  assert.equal(back.stale, undefined);
  assert.equal(back.failed, 0);
});

test('without any snapshot a failed walk is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    now: () => SAMPLED,
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'sea_weather_unavailable');
  assert.equal(calls, 1, 'the station list, once');
});

test('requests waiting on one walk share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const urls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const ok = viva(urls);
  const request = harness({
    now: () => SAMPLED + 60_000,
    fetchImpl: async (url) => {
      await gate;
      return ok(url);
    },
  });
  const waiting = [request(), request(), request()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(urls.length, 4, 'the list plus three stations, once');
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[sea-weather] 3 stations'],
  );
});

test('SEA_WEATHER_SOURCE=smhi reads three SMHI files and never ViVa', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  assert.equal(seaWeatherFromSmhi({ SEA_WEATHER_SOURCE: ' SMHI ' }), true);
  assert.equal(seaWeatherFromSmhi({}), false);
  const NOW = Date.parse('2026-11-11T12:00:00Z');
  const urls = [];
  let wavesDown = true;
  const request = harness({
    now: () => NOW,
    env: { SEA_WEATHER_SOURCE: 'smhi' },
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (wavesDown && String(url) === SMHI_SEA_URL(1))
        return new Response('down', { status: 503 });
      return Response.json({
        station: [
          {
            key: '2111',
            name: 'Onsala',
            latitude: 57.39,
            longitude: 11.92,
            value: [{ date: NOW - 3_600_000, value: '9.6', quality: 'O' }],
          },
        ],
      });
    },
  });
  const body = (await request()).json();
  assert.deepEqual(urls.sort(), [12, 5, 1].map(SMHI_SEA_URL).sort());
  assert.equal(
    urls.some((url) => url.startsWith(VIVA_URL)),
    false,
  );
  assert.equal(body.source, 'smhi');
  assert.deepEqual(
    body.stations.map((row) => [row.name, row.level, row.waterTemp]),
    [['Onsala', 9.6, 9.6]],
  );
});

test('without the level file an SMHI refresh fails like a silent ViVa', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness({
    env: { SEA_WEATHER_SOURCE: 'smhi' },
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  const answer = await request();
  assert.equal(answer.status, 502);
  assert.equal(answer.json().error, 'sea_weather_unavailable');
});
