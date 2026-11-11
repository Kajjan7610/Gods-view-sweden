// The Swedish routes that spend a key answer the app's own page only: a
// request another site's page makes is refused before anything is asked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cityTransitProxy } from './cityTransit.js';
import { powerGridEntsoeProxy } from './powerGridEntsoe.js';
import { speedCamerasProxy } from './speedCameras.js';
import { trafikverketRoadsProxy } from './trafikverketRoads.js';
import { trafikverketWeatherProxy } from './trafikverketWeather.js';
import { transitAlertsProxy } from './transitAlerts.js';

function mounted(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes;
}

async function ask(handler, headers) {
  const res = {
    destroyed: false,
    statusCode: 0,
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      this.body = body;
    },
  };
  await handler(
    { method: 'GET', url: '/?lat=59.33&lon=18.07', headers, socket: {} },
    res,
  );
  return res;
}

test('a key-spending Swedish route refuses another site before anything is asked', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}');
  };
  const env = {
    TRAFIKVERKET_API_KEY: 'a',
    SWEDAVIA_FLIGHTINFO_KEY: 'c',
    SWEDAVIA_WAITTIME_KEY: 'd',
    TRAFIKLAB_REALTIME_KEY: 'e',
    ENTSOE_SECURITY_TOKEN: 'f',
  };
  const options = { fetchImpl, env, stopsFor: async () => [] };
  const paths = [];
  for (const proxy of [
    cityTransitProxy,
    powerGridEntsoeProxy,
    speedCamerasProxy,
    trafikverketRoadsProxy,
    trafikverketWeatherProxy,
    transitAlertsProxy,
  ])
    for (const [path, handler] of mounted(proxy(options))) {
      paths.push(path);
      const foreign = await ask(handler, {
        host: 'localhost:4173',
        origin: 'https://example.com',
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(foreign.statusCode, 403, path);
    }
  assert.equal(calls, 0);
  for (const path of [
    '/api/city-transit',
    '/api/airport-board',
    '/api/airport-flight',
    '/api/airport-routes',
    '/api/power-grid',
    '/api/speed-cameras',
    '/api/transit-alerts',
  ])
    assert.ok(paths.includes(path), path);
  assert.ok(paths.length >= 9, 'the two Trafikverket layers too');
});

test("the app's own page is still answered", async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const handler = mounted(
    cityTransitProxy({ fetchImpl: async () => new Response('{}'), env: {} }),
  ).get('/api/city-transit');
  const own = await ask(handler, {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(own.statusCode, 200);
});
