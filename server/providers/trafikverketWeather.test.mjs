import assert from 'node:assert/strict';
import test from 'node:test';

import {
  trafikverketWeatherProxy,
  trafikverketWeatherQuery,
} from './trafikverketWeather.js';

const SAMPLE = '2026-11-04T16:55:03.001+01:00';
const PAYLOAD = {
  RESPONSE: {
    RESULT: [
      {
        WeatherMeasurepoint: [
          {
            Id: '222',
            Name: 'Stocksund',
            Geometry: { WGS84: 'POINT (18.04221 59.38437)' },
            Observation: {
              Sample: SAMPLE,
              Weather: { Precipitation: 'snow' },
              Surface: { Temperature: { Value: -0.6 } },
              Air: { Temperature: { Value: 0.2 }, Dewpoint: { Value: -1 } },
            },
          },
        ],
      },
    ],
  },
};

/** Drive the plugin's middleware with a minimal req/res pair. */
function harness(options) {
  let route;
  let handler;
  const plugin = trafikverketWeatherProxy(options);
  plugin.configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async (method = 'GET', url = '/') => {
    const res = {
      destroyed: false,
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method, url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

test('the query asks for road weather stations and escapes the key', () => {
  const body = trafikverketWeatherQuery('k"<&');
  assert.match(body, /authenticationkey="k&quot;&lt;&amp;"/);
  assert.match(
    body,
    /objecttype="WeatherMeasurepoint" namespace="Road.WeatherInfo" schemaversion="2.1"/,
  );
  assert.match(body, /<EQ name="Deleted" value="false" \/>/);
  assert.match(
    body,
    /<INCLUDE>Observation.Surface.Temperature.Value<\/INCLUDE>/,
  );
});

test('without a key the route answers not_configured and never fetches', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    env: {},
    fetchImpl: async () => {
      calls++;
      return Response.json(PAYLOAD);
    },
  });
  assert.equal(request.route(), '/api/trafikverket-weather');
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.json().error, 'not_configured');
  assert.equal(calls, 0);
});

test('with a key one POST serves normalized stations, then the 5-minute cache', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  let clock = Date.parse('2026-11-04T17:00:00+01:00');
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(PAYLOAD);
    },
  });
  const first = await request();
  assert.equal(first.status, 200);
  const [station] = first.json().stations;
  assert.equal(station.name, 'Stocksund');
  assert.equal(station.risk, 'precipitation');
  assert.equal(first.body.includes('secret-key'), false);
  assert.equal(calls[0].init.method, 'POST');
  clock += 4 * 60_000;
  await request();
  assert.equal(calls.length, 1, 'served from the cache');
  clock += 2 * 60_000;
  await request();
  assert.equal(calls.length, 2, 'refreshed after 5 minutes');
});

test('a refused key reports keyRefused without leaking the key', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    fetchImpl: async () =>
      Response.json({
        RESPONSE: {
          RESULT: [
            {
              ERROR: { SOURCE: 'Security', MESSAGE: 'Invalid authentication' },
            },
          ],
        },
      }),
  });
  const response = await request();
  assert.equal(response.status, 502);
  assert.deepEqual(response.json(), {
    error: 'trafikverket_weather_unavailable',
    keyRefused: true,
  });
  assert.equal(
    lines.some((line) => line.includes('secret-key')),
    false,
  );
});

test('after a failed refresh Trafikverket is left alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00+01:00');
  let fail = false;
  let calls = 0;
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail
        ? new Response('down', { status: 503 })
        : Response.json(PAYLOAD);
    },
  });
  await request();
  fail = true;
  clock += 6 * 60_000;
  const first = await request();
  assert.equal(first.json().stale, true);
  assert.equal(first.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 2);
  // Within the minute: the last snapshot again, Trafikverket not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(calls, 2);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  fail = false;
  const back = await request();
  assert.equal(calls, 3);
  assert.equal(back.json().stale, undefined);
  assert.equal(back.headers['X-Data-Stale'], undefined);
});

test('a refused key is not sent again within the minute, and the answer still says so', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00+01:00');
  let refused = true;
  let calls = 0;
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        refused
          ? {
              RESPONSE: {
                RESULT: [
                  {
                    ERROR: {
                      SOURCE: 'Security',
                      MESSAGE: 'Invalid authentication',
                    },
                  },
                ],
              },
            }
          : PAYLOAD,
      );
    },
  });
  assert.equal((await request()).json().keyRefused, true);
  for (let i = 0; i < 3; i += 1) {
    const paused = await request();
    assert.equal(paused.status, 502);
    assert.deepEqual(paused.json(), {
      error: 'trafikverket_weather_unavailable',
      keyRefused: true,
    });
  }
  assert.equal(calls, 1);
  // After the minute the key is tried again; accepted, it serves.
  clock += 61_000;
  refused = false;
  const served = await request();
  assert.equal(calls, 2);
  assert.equal(served.status, 200);
  assert.equal(served.json().stations.length, 1);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json(PAYLOAD);
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
  assert.equal(calls, 1);
  assert.equal(log.mock.callCount(), 1);
});
