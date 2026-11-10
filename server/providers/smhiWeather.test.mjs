import assert from 'node:assert/strict';
import test from 'node:test';

import { FORECAST_URL, smhiWeatherProxy } from './smhiWeather.js';

function harness(options) {
  let route;
  let handler;
  smhiWeatherProxy(options).configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async (url = '/') => {
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
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

const NOW = Date.parse('2026-11-04T22:00:00Z');
const OBS = {
  station: [
    {
      key: '97400',
      name: 'Västerås',
      latitude: 59.6,
      longitude: 16.6,
      value: [{ date: NOW - 30 * 60_000, value: '3.9', quality: 'G' }],
    },
  ],
};

test('observations merge four parameters; a missing one does not fail them', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  const request = harness({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes('/parameter/7/')
        ? new Response('down', { status: 503 })
        : Response.json(OBS);
    },
  });
  assert.equal(request.route(), '/api/smhi-weather');
  const [row] = (await request()).json().stations;
  assert.equal(row.name, 'Västerås');
  assert.equal(row.airTemp, 3.9);
  assert.equal(row.precipitation, null);
  assert.equal(urls.length, 4);
  await request();
  assert.equal(urls.length, 4, 'cached');
});

test('forecasts are per rounded point, inside the Nordic area only, and cached', async (t) => {
  const urls = [];
  const request = harness({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return Response.json({
        geometry: { coordinates: [16.55, 59.6] },
        timeSeries: [
          {
            time: new Date(NOW).toISOString(),
            data: { air_temperature: 3, symbol_code: 1 },
          },
        ],
      });
    },
  });
  const first = await request('/forecast?lat=59.60123&lon=16.54987');
  assert.equal(first.status, 200);
  assert.equal(first.json().next24.max, 3);
  assert.deepEqual(urls, [FORECAST_URL(16.55, 59.601)]);
  await request('/forecast?lat=59.6012&lon=16.5499');
  assert.equal(urls.length, 1, 'same rounded point, cached');
  assert.equal((await request('/forecast?lat=40&lon=-74')).status, 400);
  assert.equal((await request('/forecast?lat=x&lon=1')).status, 400);
  t.mock.method(console, 'warn', () => {});
  assert.equal((await request('/other')).status, 404);
});

test('after a failed refresh SMHI is left alone for a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  let fail = false;
  let calls = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail ? new Response('down', { status: 503 }) : Response.json(OBS);
    },
  });
  await request();
  assert.equal(calls, 4);
  fail = true;
  clock += 11 * 60_000;
  const first = await request();
  assert.equal(first.json().stale, true);
  assert.equal(calls, 8);
  // Within the minute: the last observations again, SMHI not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(calls, 8);
  // After it, asked once more.
  clock += 31_000;
  fail = false;
  assert.equal((await request()).json().stale, undefined);
  assert.equal(calls, 12);
});

test('without any observations a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'smhi_weather_unavailable');
  assert.equal(calls, 4);
});

test('an answer missing a parameter file is asked for again after a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  let clock = NOW;
  let windDown = true;
  const urls = [];
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return windDown && String(url).includes('/parameter/4/')
        ? new Response('down', { status: 503 })
        : Response.json(OBS);
    },
  });
  assert.equal((await request()).json().stations[0].wind, null);
  clock += 30_000;
  await request();
  assert.equal(urls.length, 4, 'kept for a minute');
  windDown = false;
  clock += 31_000;
  assert.equal((await request()).json().stations[0].wind, 3.9);
  assert.equal(urls.length, 8);
  // A complete answer is kept the full ten minutes.
  clock += 9 * 60_000;
  await request();
  assert.equal(urls.length, 8);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = harness({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json(OBS);
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
  assert.equal(calls, 4);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[smhi-weather] 1 stations'],
  );
});
