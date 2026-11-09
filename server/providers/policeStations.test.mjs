// The Polisen police station route: one upstream read per day, stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { POLISEN_STATIONS_URL, policeStationsProxy } from './policeStations.js';

function route(options) {
  let handler = null;
  policeStationsProxy(options).configureServer({
    middlewares: { use: (path, fn) => (handler = fn) },
  });
  return async (url = '/') => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
}

const NOW = Date.parse('2026-11-09T18:00:00Z');
const list = [
  {
    id: 811,
    name: 'Polisen Alvesta',
    Url: 'https://polisen.se/om-polisen/kontakt/polisstationer/kronoberg/alvesta/',
    location: { name: 'Värendsgatan 14, Alvesta', gps: '56.90,14.55' },
    services: [{ name: 'Hämta pass och id-kort' }],
  },
];

test('the route serves normalized stations and caches them for a day', async () => {
  let now = NOW;
  const calls = [];
  const get = route({
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length > 1) throw new Error('down');
      return new Response(JSON.stringify(list));
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.body.stations[0].name, 'Alvesta');
  assert.deepEqual(first.body.stations[0].services, ['passport-collect']);
  assert.deepEqual(calls, [POLISEN_STATIONS_URL]);
  now += 60 * 60_000;
  assert.equal((await get()).body.stations.length, 1);
  assert.equal(calls.length, 1, 'served from cache');
  now += 24 * 60 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal((await get('/other')).status, 404);
});

test('an empty or failed list without a cache answers 502', async () => {
  const get = route({
    now: () => NOW,
    fetchImpl: async () => new Response('[]'),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'police_stations_unavailable');
});
