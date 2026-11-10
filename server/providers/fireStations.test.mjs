// The MCF fire station route: one upstream read per day, stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRE_STATIONS_RETRY_AFTER_FAILURE_MS,
  MCF_FIRE_STATIONS_URL,
  fireStationsProxy,
} from './fireStations.js';

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

test('a failed refresh leaves MCF alone for five minutes, and serves the last snapshot meanwhile', async () => {
  let now = NOW;
  let down = false;
  let calls = 0;
  const get = route({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (down) throw new Error('down');
      return new Response(JSON.stringify(collection()));
    },
  });
  assert.equal((await get()).status, 200);
  now += 24 * 60 * 60_000;
  down = true;
  assert.equal((await get()).body.stale, true);
  assert.equal(calls, 2);

  // Every visitor during the pause gets the last snapshot, with no new read.
  now += FIRE_STATIONS_RETRY_AFTER_FAILURE_MS - 1;
  const paused = await get();
  assert.equal(paused.status, 200);
  assert.equal(paused.body.stale, true);
  assert.equal(calls, 2, 'no upstream read during the pause');

  now += 1;
  down = false;
  const fresh = await get();
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.stale, undefined);
  assert.equal(calls, 3);
});

test('a failure without a snapshot pauses too, and answers 502 meanwhile', async () => {
  let now = NOW;
  let calls = 0;
  const get = route({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return new Response(JSON.stringify(collection()));
    },
  });
  assert.equal((await get()).status, 502);
  now += FIRE_STATIONS_RETRY_AFTER_FAILURE_MS - 1;
  const paused = await get();
  assert.equal(paused.status, 502);
  assert.equal(paused.body.error, 'fire_stations_unavailable');
  assert.equal(calls, 1, 'no upstream read during the pause');
  now += 1;
  assert.equal((await get()).status, 200);
  assert.equal(calls, 2);
});

test('a full page without a count is refused: more may lie behind it', async () => {
  const [feature] = collection().features;
  const full = {
    type: 'FeatureCollection',
    features: Array.from({ length: 1000 }, (_, index) => ({
      ...feature,
      id: `US_fireStation.s${index}`,
      properties: { ...feature.properties, inspireid: `s${index}` },
    })),
  };
  const get = route({
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify(full)),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'fire_stations_unavailable');

  // One short of the limit is a whole collection.
  full.features.pop();
  const whole = route({
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify(full)),
  });
  assert.equal((await whole()).status, 200);
});

test('a page that links to a next one is refused, even without a count', async () => {
  const { numberMatched, ...page } = collection();
  assert.equal(numberMatched, 1);
  const get = route({
    now: () => NOW,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ...page,
          links: [
            { rel: 'self', href: 'https://inspire.mcf.se/items' },
            { rel: 'next', href: 'https://inspire.mcf.se/items?offset=1' },
          ],
        }),
      ),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'fire_stations_unavailable');
});
