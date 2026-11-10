// The speed camera route: one Trafikverket read a day, near lists, no key leaks.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS,
  speedCamerasProxy,
  speedCamerasQuery,
} from './speedCameras.js';

function route(options) {
  let handler = null;
  speedCamerasProxy(options).configureServer({
    middlewares: { use: (path, fn) => (handler = fn) },
  });
  return async (url = '/') => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
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

const DAY_MS = 24 * 60 * 60_000;
const answerOf = (rows) => ({
  RESPONSE: { RESULT: [{ TrafficSafetyCamera: rows }] },
});
const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('a failed refresh leaves Trafikverket alone for five minutes, the last list marked stale', async (t) => {
  quiet(t);
  let now = Date.parse('2026-11-10T10:00:00Z');
  let calls = 0;
  let healthy = true;
  const get = route({
    now: () => now,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async () => {
      calls += 1;
      return healthy
        ? new Response(JSON.stringify(answer))
        : new Response('no', { status: 500 });
    },
  });
  const fresh = await get();
  assert.equal(fresh.headers['X-Data-Stale'], undefined);

  now += DAY_MS;
  healthy = false;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 2);

  // Healthy again, but the pause has a millisecond left.
  healthy = true;
  now += SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS - 1;
  const near = await get('/?lat=59.33&lon=18.06');
  assert.equal(near.body.stale, true);
  assert.equal(near.headers['X-Data-Stale'], 'true');
  assert.equal((await get()).body.stale, true);
  assert.equal(calls, 2, 'no read during the pause');

  now += 1;
  const again = await get();
  assert.equal(calls, 3);
  assert.equal(again.body.stale, undefined);
  assert.equal(again.headers['X-Data-Stale'], undefined);
});

test('the pause holds without a list too: 502 and no new read', async (t) => {
  quiet(t);
  let now = Date.parse('2026-11-10T10:00:00Z');
  let calls = 0;
  let healthy = false;
  const get = route({
    now: () => now,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async () => {
      calls += 1;
      return healthy
        ? new Response(JSON.stringify(answer))
        : new Response('no', { status: 500 });
    },
  });
  assert.equal((await get()).status, 502);
  healthy = true;
  const paused = await get();
  assert.equal(paused.status, 502);
  assert.equal(paused.body.error, 'speed_cameras_unavailable');
  assert.equal(calls, 1);
  now += SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS;
  assert.equal((await get()).status, 200);
  assert.equal(calls, 2);
});

test('an answer without a single site is a failure, not an empty map for a day', async (t) => {
  quiet(t);
  let now = Date.parse('2026-11-10T10:00:00Z');
  let rows = [];
  const get = route({
    now: () => now,
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async () => new Response(JSON.stringify(answerOf(rows))),
  });
  const first = await get();
  assert.equal(first.status, 502);
  assert.equal(first.body.error, 'speed_cameras_unavailable');

  now += SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS;
  rows = [camera('near', 18.07, 59.33), camera('far', 13.0, 55.6)];
  assert.equal((await get()).body.cameras.length, 2);

  now += DAY_MS;
  rows = [];
  const kept = await get();
  assert.equal(kept.status, 200);
  assert.equal(kept.body.stale, true);
  assert.equal(kept.body.cameras.length, 2);
});

test('half a position is a 400 before anything is read', async () => {
  let calls = 0;
  const get = route({
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(answer));
    },
  });
  for (const url of [
    '/?lat=59',
    '/?lon=18',
    '/?lat=&lon=',
    '/?lat=59&lon=%20',
  ]) {
    const res = await get(url);
    assert.equal(res.status, 400, url);
    assert.equal(res.body.error, 'lat_lon_required');
  }
  assert.equal(calls, 0);
});

test('one read for everyone waiting, logged once with the sites that lack a county', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  let release = null;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const get = route({
    env: { TRAFIKVERKET_API_KEY: 'k' },
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return new Response(
        JSON.stringify(
          answerOf([
            camera('near', 18.07, 59.33),
            camera('far', 13.0, 55.6),
            { ...camera('odd', 15.0, 58.0), CountyNo: [2] },
          ]),
        ),
      );
    },
  });
  const waiting = [get(), get(), get('/?lat=59.33&lon=18.06')];
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((res) => res.status),
    [200, 200, 200],
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('[speed-cameras]')),
    ['[speed-cameras] 3 camera sites, 1 without a county (CountyNo 2: 1)'],
  );
});
