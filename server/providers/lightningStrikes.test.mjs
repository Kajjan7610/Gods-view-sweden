// The DMI lightning route: the last hour over the Nordics, a minute of cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dmiLightningUrl, lightningStrikesProxy } from './lightningStrikes.js';

function route(options) {
  let handler = null;
  lightningStrikesProxy(options).configureServer({
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

const NOW = Date.parse('2026-07-10T15:00:00Z');
const strike = (id, minutesAgo) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [15.5, 58.4] },
  properties: {
    type: 0,
    amp: -8,
    sensors: '1,2,3',
    observed: new Date(NOW - minutesAgo * 60_000).toISOString(),
  },
});

test('the upstream query asks for the last hour over the Nordics, newest first', () => {
  const url = new URL(dmiLightningUrl(NOW, 10_000));
  assert.equal(url.origin, 'https://opendataapi.dmi.dk');
  assert.equal(
    url.searchParams.get('datetime'),
    '2026-07-10T14:00:00Z/2026-07-10T15:00:00Z',
  );
  assert.equal(url.searchParams.get('bbox'), '4,54,32,71');
  assert.equal(url.searchParams.get('sortorder'), 'observed,DESC');
  assert.equal(url.searchParams.get('offset'), '10000');
  assert.equal(new URL(dmiLightningUrl(NOW)).searchParams.has('offset'), false);
});

test('the route serves the last hour, caches a minute and goes stale on failure', async () => {
  let now = NOW;
  const calls = [];
  const get = route({
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length > 1) throw new Error('down');
      return new Response(
        JSON.stringify({ features: [strike('b', 30), strike('a', 1)] }),
      );
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.strikes.map((row) => row.id),
    ['a', 'b'],
  );
  assert.equal(first.body.truncated, false);
  now += 30_000;
  await get();
  assert.equal(calls.length, 1, 'served from cache');
  now += 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  now += 11 * 60_000;
  assert.equal((await get()).status, 502);
  assert.equal((await get('/other')).status, 404);
});

test('a full first page reads one more and marks the cap', async () => {
  const offsets = [];
  const full = Array.from({ length: 10_000 }, (_, i) => strike(`s${i}`, 5));
  const get = route({
    now: () => NOW,
    fetchImpl: async (url) => {
      offsets.push(new URL(url).searchParams.get('offset'));
      return new Response(JSON.stringify({ features: full }));
    },
  });
  const res = await get();
  assert.deepEqual(offsets, [null, '10000']);
  assert.equal(res.body.truncated, true);
});
