import assert from 'node:assert/strict';
import test from 'node:test';

import { KP_URL, OVATION_URL, auroraProxy } from './aurora.js';

function harness(options) {
  let route;
  let handler;
  auroraProxy(options).configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async () => {
    const res = {
      destroyed: false,
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

test('the grid and Kp come together; a missing Kp does not fail the grid', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  let kpDown = false;
  let clock = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url) === KP_URL)
        return kpDown
          ? new Response('down', { status: 503 })
          : Response.json([{ time_tag: '2026-11-04T18:00:00', Kp: 3 }]);
      return Response.json({
        'Forecast Time': '2026-11-04T23:04:00Z',
        coordinates: [[20, 68, 22]],
      });
    },
  });
  assert.equal(request.route(), '/api/aurora');
  const first = (await request()).json();
  assert.equal(first.rows[68 - 30][20], 22);
  assert.equal(first.kp.kp, 3);
  assert.deepEqual(urls.sort(), [KP_URL, OVATION_URL].sort());
  kpDown = true;
  clock += 11 * 60_000;
  const second = (await request()).json();
  assert.equal(second.kp, null);
  assert.equal(second.rows[68 - 30][20], 22);
});

/** NOAA as the route sees it: a counter, a switch and a gate. */
function noaa(state) {
  return async (url) => {
    state.calls += 1;
    await state.gate;
    if (state.fail) return new Response('down', { status: 503 });
    if (String(url) === KP_URL)
      return Response.json([{ time_tag: '2026-11-04T18:00:00', Kp: 3 }]);
    return Response.json({
      'Forecast Time': '2026-11-04T23:04:00Z',
      coordinates: [[20, 68, 22]],
    });
  };
}

test('after a failed refresh NOAA is left alone for a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const state = { calls: 0, fail: false };
  let clock = 0;
  const request = harness({ now: () => clock, fetchImpl: noaa(state) });
  await request();
  assert.equal(state.calls, 2, 'the grid and Kp');
  state.fail = true;
  clock += 11 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(state.calls, 4);
  // Within the minute: the last grid again, NOAA not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(state.calls, 4);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  state.fail = false;
  const back = (await request()).json();
  assert.equal(state.calls, 6);
  assert.equal(back.stale, undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const state = { calls: 0, fail: true };
  const request = harness({ now: () => 0, fetchImpl: noaa(state) });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'aurora_unavailable');
  assert.equal(state.calls, 2);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const state = {
    calls: 0,
    fail: false,
    gate: new Promise((resolve) => (release = resolve)),
  };
  const request = harness({ now: () => 0, fetchImpl: noaa(state) });
  const waiting = [request(), request(), request()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(state.calls, 2);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[aurora] OVATION 2026-11-04T23:04:00.000Z, Kp 3'],
  );
});
