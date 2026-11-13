import assert from 'node:assert/strict';
import test from 'node:test';

import { SMHI_SEA_URL, seaWeatherProxy } from './seaWeather.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');

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

/** SMHI answering every file with one station, Onsala, measured an hour ago. */
function smhi(urls, clock = () => NOW) {
  return async (url) => {
    urls.push(String(url));
    return Response.json({
      station: [
        {
          key: '2111',
          name: 'Onsala',
          latitude: 57.39,
          longitude: 11.92,
          value: [{ date: clock() - 3_600_000, value: '9.6', quality: 'O' }],
        },
      ],
    });
  };
}

test('a refresh reads three SMHI files, then keeps them ten minutes', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  const urls = [];
  let wavesDown = true;
  const ok = smhi(urls, () => clock);
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      if (wavesDown && String(url) === SMHI_SEA_URL(1)) {
        urls.push(String(url));
        return new Response('down', { status: 503 });
      }
      return ok(url);
    },
  });
  assert.equal(request.route(), '/api/sea-weather');
  const body = (await request()).json();
  assert.deepEqual(urls.slice().sort(), [12, 5, 1].map(SMHI_SEA_URL).sort());
  assert.equal(body.source, 'smhi');
  assert.deepEqual(
    body.stations.map((row) => [row.name, row.level, row.waterTemp]),
    [['Onsala', 9.6, 9.6]],
  );
  clock += 5 * 60_000;
  await request();
  assert.equal(urls.length, 3, 'cached for ten minutes');
  wavesDown = false;
  clock += 6 * 60_000;
  await request();
  assert.equal(urls.length, 6);
});

test('without the level file a refresh fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness({
    now: () => NOW,
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  const answer = await request();
  assert.equal(answer.status, 502);
  assert.equal(answer.json().error, 'sea_weather_unavailable');
});

test('a failure serves the last stations marked stale, then gives up', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  let fail = false;
  const ok = smhi([], () => NOW);
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

test('after a failed refresh SMHI is left alone for a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const urls = [];
  let clock = NOW;
  let fail = false;
  const ok = smhi(urls, () => clock);
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      if (!fail) return ok(url);
      urls.push(String(url));
      return new Response('down', { status: 503 });
    },
  });
  await request();
  fail = true;
  clock += 11 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(urls.length, 6);
  clock += 30_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(urls.length, 6, 'no new refresh within the minute');
  clock += 31_000;
  fail = false;
  const back = (await request()).json();
  assert.equal(urls.length, 9);
  assert.equal(back.stale, undefined);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const urls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const ok = smhi(urls);
  const request = harness({
    now: () => NOW,
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
  assert.equal(urls.length, 3, 'three files, once');
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[sea-weather] 1 SMHI stations'],
  );
});
