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
