import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  API_BASE,
  groupStations,
  pollutantSeries,
  smhiAirQualityProxy,
} from './smhiAirQuality.js';

const NOW = Date.parse('2026-11-04T22:10:00Z');
const series = (id, label, name, lon, lat) => ({
  id,
  label: `${label} SPP-X, ${name}, SPP-X`,
  station: {
    properties: { label: name },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  },
});
const LIST = [
  series('1', 'NO2', 'Göteborg Gårda', 11.9946, 57.7009),
  series('2', 'PM10', 'Göteborg Gårda', 11.9946, 57.7009),
  series('3', 'NOX as NO2', 'Göteborg Gårda', 11.9946, 57.7009),
  series('4', 'PM2.5', 'Gammal station', 15, 58),
  series('5', 'O3', 'Vavihill', 13.15, 56.02),
];

async function harness(t, { fail = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'smhi-aq-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  let handler;
  const cachePath = path.join(dir, 'series.json');
  smhiAirQualityProxy({
    now: () => NOW,
    cachePath,
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body && JSON.parse(init.body),
      });
      if (fail) return new Response('down', { status: 503 });
      // One pollutant list answers everything; the label filter sorts it.
      if (String(url).includes('/timeseries?phenomenon='))
        return Response.json(String(url).endsWith('=8') ? LIST : []);
      const answer = {};
      for (const id of JSON.parse(init.body).timeseries)
        answer[id] = {
          values:
            id === '4'
              ? []
              : [
                  { timestamp: NOW - 2 * 3600e3, value: 10 },
                  { timestamp: NOW - 3600e3, value: Number(id) * 11 },
                ],
        };
      return Response.json(answer);
    },
  }).configureServer({ middlewares: { use: (_path, fn) => (handler = fn) } });
  const request = async (url = '/') => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return { request, calls, cachePath };
}

test('series of the four pollutants are kept, with their station', () => {
  const kept = pollutantSeries(LIST);
  assert.deepEqual(
    kept.map((one) => `${one.id}:${one.pollutant}`),
    ['1:NO2', '2:PM10', '4:PM2.5', '5:O3'],
  );
  assert.deepEqual(kept[0], {
    id: '1',
    pollutant: 'NO2',
    name: 'Göteborg Gårda',
    lat: 57.7009,
    lon: 11.9946,
  });
});

test('series of one place share a station row', () => {
  const kept = pollutantSeries(LIST);
  const latest = new Map([
    ['1', { value: 20, at: NOW }],
    ['2', { value: 9, at: NOW }],
    ['5', { value: 60, at: NOW }],
  ]);
  const stations = groupStations(kept, latest);
  assert.deepEqual(
    stations.map((station) => [station.name, Object.keys(station.pollutants)]),
    [
      ['Göteborg Gårda', ['NO2', 'PM10']],
      ['Vavihill', ['O3']],
    ],
  );
});

test('the first request warms up; active series are found once and kept on disk', async (t) => {
  const { request, calls, cachePath } = await harness(t);
  const first = await request();
  assert.equal(first.status, 503);
  assert.equal(first.json().error, 'warming_up');
  // Let the background discovery finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.deepEqual(
    saved.series.map((one) => one.id),
    ['1', '2', '5'],
    'the silent series is dropped',
  );
  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.url),
    [8, 5, 6001, 7].map((id) => `${API_BASE}/timeseries?phenomenon=${id}`),
  );
  assert.equal(calls[4].url, `${API_BASE}/timeseries/getData`);
  assert.equal(calls[4].body.timespan, 'PT24H/2026-11-04T23:00:00Z');

  const ready = await request();
  assert.equal(ready.status, 200);
  const { stations } = ready.json();
  assert.equal(stations.length, 2);
  assert.deepEqual(stations[0].pollutants.NO2, {
    value: 11,
    at: NOW - 3600e3,
  });
  const valuesCall = calls.at(-1);
  assert.deepEqual(valuesCall.body.timeseries, ['1', '2', '5']);
  assert.equal(valuesCall.body.timespan, 'PT3H/2026-11-04T23:00:00Z');
  const before = calls.length;
  await request();
  assert.equal(calls.length, before, 'cached');
  assert.equal((await request('/other')).status, 404);
});

test('a failed discovery is not retried at once', async (t) => {
  const { request, calls } = await harness(t, { fail: true });
  assert.equal((await request()).status, 503);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await request()).status, 503);
  assert.equal(calls.length, 1, 'one listing attempt only');
});
