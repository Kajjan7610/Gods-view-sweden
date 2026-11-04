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
