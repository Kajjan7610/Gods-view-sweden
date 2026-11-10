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

test('after a failed refresh SSM is left alone for a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  let fail = false;
  let calls = 0;
  const request = route({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail ? new Response('down', { status: 503 }) : Response.json(body);
    },
  });
  await request();
  fail = true;
  clock += 11 * 60_000;
  assert.equal((await request()).body.stale, true);
  assert.equal(calls, 2);
  // Within the minute: the last stations again, SSM not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).body.stale, true);
  assert.equal(calls, 2);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  fail = false;
  const back = await request();
  assert.equal(calls, 3);
  assert.equal(back.body.stale, undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = route({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.body.error, 'gamma_radiation_unavailable');
  assert.equal(calls, 1);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = route({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json(body);
    },
  });
  const waiting = [request(), request(), request()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[gamma-radiation] 1 stations'],
  );
});
