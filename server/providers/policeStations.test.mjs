// The Polisen police station route: one upstream read per day, stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLICE_STATIONS_RETRY_AFTER_FAILURE_MS,
  POLISEN_STATIONS_URL,
  policeStationsProxy,
} from './policeStations.js';

function route(options) {
  let handler = null;
  policeStationsProxy({ gate: async () => {}, ...options }).configureServer({
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

test('after a failed refresh Polisen is left alone for five minutes', async () => {
  let now = NOW;
  let calls = 0;
  let down = false;
  const get = route({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (down) throw new Error('down');
      return new Response(JSON.stringify(list));
    },
  });
  await get();
  down = true;
  now += 25 * 60 * 60_000;
  assert.equal((await get()).body.stale, true);
  assert.equal(calls, 2);
  now += POLICE_STATIONS_RETRY_AFTER_FAILURE_MS - 1;
  const paused = await get();
  assert.equal(paused.status, 200);
  assert.equal(paused.body.stale, true);
  assert.equal(calls, 2, 'no new read during the pause');
  down = false;
  now += 1;
  const fresh = await get();
  assert.equal(fresh.body.stale, undefined);
  assert.equal(calls, 3, 'the pause is over');
});

test('a failure without a cache pauses too, and answers 502 meanwhile', async () => {
  let now = NOW;
  let calls = 0;
  const get = route({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('down');
    },
  });
  assert.equal((await get()).status, 502);
  assert.equal((await get()).status, 502);
  assert.equal(calls, 1);
  now += POLICE_STATIONS_RETRY_AFTER_FAILURE_MS;
  assert.equal((await get()).status, 502);
  assert.equal(calls, 2);
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
