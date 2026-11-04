import assert from 'node:assert/strict';
import test from 'node:test';

import { VIVA_URL, seaWeatherProxy } from './seaWeather.js';

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
