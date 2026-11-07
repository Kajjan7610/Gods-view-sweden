// The speed camera route: one Trafikverket read a day, near lists, no key leaks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { speedCamerasProxy, speedCamerasQuery } from './speedCameras.js';

function route(options) {
  let handler = null;
  speedCamerasProxy(options).configureServer({
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

const camera = (id, lon, lat) => ({
  Id: id,
  Name: id,
  RoadNumber: 'E4',
  Bearing: 10,
  CountyNo: [1],
  Geometry: { WGS84: `POINT (${lon} ${lat})` },
  Deleted: false,
});
const answer = {
  RESPONSE: {
    RESULT: [
      {
        TrafficSafetyCamera: [
          camera('near', 18.07, 59.33),
          camera('far', 13.0, 55.6),
        ],
      },
    ],
  },
};

test('the query asks for sites in use and escapes the key', () => {
  const query = speedCamerasQuery('a"b');
  assert.match(query, /objecttype="TrafficSafetyCamera"/);
  assert.match(query, /<EQ name="Deleted" value="false" \/>/);
  assert.match(query, /authenticationkey="a&quot;b"/);
});

test('the route serves every site, caches a day and goes stale on failure', async () => {
  let now = Date.parse('2026-11-07T10:00:00Z');
  const bodies = [];
  const get = route({
    now: () => now,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async (url, init) => {
      bodies.push(init.body);
      if (bodies.length > 1) return new Response('no', { status: 500 });
      return new Response(JSON.stringify(answer));
    },
  });
  const all = await get();
  assert.equal(all.status, 200);
  assert.equal(all.body.cameras.length, 2);
  assert.equal(all.body.stale, undefined);
  now += 60 * 60_000;
  await get();
  assert.equal(bodies.length, 1, 'served from cache');

  const near = await get('/?lat=59.33&lon=18.06');
  assert.equal(near.body.count, 1);
  assert.equal(near.body.radiusKm, 15);
  assert.equal(near.body.nearest[0].id, 'near');
  assert.equal(near.body.nearest[0].km, 0.6);
  assert.equal((await get('/?lat=x&lon=1')).status, 400);

  now += 24 * 60 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal((await get('/other')).status, 404);
});

test('without a key the route answers 503 and never calls out', async () => {
  let calls = 0;
  const get = route({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal((await get()).status, 503);
  assert.equal(calls, 0);
});

test('a first failure is a 502 without the key in the answer', async () => {
  const get = route({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    fetchImpl: async () => new Response('x', { status: 401 }),
  });
  const res = await get();
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /secret-key/);
});
