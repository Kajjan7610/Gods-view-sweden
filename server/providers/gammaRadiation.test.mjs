// The SSM gamma route: one upstream read per ten minutes, stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SSM_GAMMA_URL, gammaRadiationProxy } from './gammaRadiation.js';

function route(options) {
  let handler = null;
  gammaRadiationProxy(options).configureServer({
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

const NOW = Date.parse('2026-11-05T14:00:00Z');
const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [17.14, 60.67] },
      properties: { id: 7, name: 'Gävle', date: NOW - 36e5, value: 0.121 },
    },
  ],
};

test('the route serves normalized stations and caches them', async () => {
  let now = NOW;
  const calls = [];
  const get = route({
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length > 1) throw new Error('down');
      return new Response(JSON.stringify(body));
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.stations.map((row) => row.name),
    ['Gävle'],
  );
  assert.deepEqual(calls, [SSM_GAMMA_URL]);
  now += 5 * 60_000;
  assert.equal((await get()).body.stations.length, 1);
  assert.equal(calls.length, 1, 'served from cache');
  now += 10 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal((await get('/other')).status, 404);
});
