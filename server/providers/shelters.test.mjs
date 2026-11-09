// The MCF shelter route: all pages once a day, each view answered from memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MCF_SHELTERS_URL, sheltersProxy } from './shelters.js';

function route(options) {
  let handler = null;
  sheltersProxy(options).configureServer({
    middlewares: { use: (path, fn) => (handler = fn) },
  });
  return async (url = '/?bbox=17.9,59.2,18.1,59.4&center=18,59.3') => {
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
const shelter = (id, lon, lat, places) => ({
  type: 'Feature',
  geometry: { type: 'MultiPoint', coordinates: [[lon, lat]] },
  properties: { id, name: `${id}-1`, numberofoccupants: places, status: 3, variantid: 1 },
});
const page = (features, matched) =>
  new Response(JSON.stringify({ numberMatched: matched, features }));

test('the route pages through MCF once a day and answers the view', async () => {
  let now = NOW;
  const calls = [];
  const get = route({
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length > 1) throw new Error('down');
      return page([shelter(1, 18.0, 59.3, 40), shelter(2, 18.05, 59.3, 60), shelter(3, 20, 63, 10)], 3);
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.places, 100);
  assert.equal(first.body.count, 3);
  assert.equal(first.body.shelters[0].id, '1');
  assert.ok(calls[0].startsWith(MCF_SHELTERS_URL));
  assert.match(calls[0], /limit=10000&startIndex=0/);
  now += 60 * 60_000;
  assert.equal((await get()).body.total, 2);
  assert.equal(calls.length, 1, 'served from memory');
  now += 24 * 60 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
});

test('a country-wide view is too wide, and a request needs a box and a centre', async () => {
  const get = route({ now: () => NOW, fetchImpl: async () => page([shelter(1, 18, 59.3, 40)], 1) });
  const wide = await get('/?bbox=10,55,24,69&center=16,62');
  assert.equal(wide.body.tooWide, true);
  assert.deepEqual(wide.body.shelters, []);
  assert.equal((await get('/?bbox=1,2,3')).status, 400);
  assert.equal((await get('/other?bbox=17.9,59.2,18.1,59.4&center=18,59.3')).status, 404);
});

test('a collection cut short by the page budget is refused', async () => {
  const get = route({
    now: () => NOW,
    fetchImpl: async () => page(Array.from({ length: 10000 }, (_, i) => shelter(i + 1, 18, 59.3, 1)), 999999),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'shelters_unavailable');
});
