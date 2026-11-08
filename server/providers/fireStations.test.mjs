// The MCF fire station route: one upstream read per day, stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MCF_FIRE_STATIONS_URL, fireStationsProxy } from './fireStations.js';

function route(options) {
  let handler = null;
  fireStationsProxy(options).configureServer({
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

const NOW = Date.parse('2026-11-08T18:00:00Z');
const collection = (matched = 1) => ({
  type: 'FeatureCollection',
  numberMatched: matched,
  features: [
    {
      type: 'Feature',
      id: 'US_fireStation.s1',
      geometry: { type: 'Point', coordinates: [18.07, 59.33] },
      properties: { inspireid: 's1', hogstaberedskapsform: 'Heltid' },
    },
  ],
});

test('the route serves normalized stations with their nearest seat and caches them', async () => {
  let now = NOW;
  const calls = [];
  const get = route({
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length > 1) throw new Error('down');
      return new Response(JSON.stringify(collection()));
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.stations[0].near, { name: 'Stockholm', km: 0 });
  assert.equal(first.body.stations[0].readiness, 'full-time');
  assert.deepEqual(calls, [MCF_FIRE_STATIONS_URL]);
  now += 60 * 60_000;
  assert.equal((await get()).body.stations.length, 1);
  assert.equal(calls.length, 1, 'served from cache');
  now += 24 * 60 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal((await get('/other')).status, 404);
});

test('a collection larger than one page is refused rather than cut short', async () => {
  const get = route({
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify(collection(2000))),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'fire_stations_unavailable');
});
