import assert from 'node:assert/strict';
import test from 'node:test';

import { POLISEN_EVENTS_URL, polisenEventsProxy } from './polisenEvents.js';
import { SWEDISH_MUNICIPALITIES } from './polisen/municipalities.js';

const PAYLOAD = [
  {
    id: 658452,
    datetime: '2026-11-04 17:12:33 +01:00',
    name: '4 november 17.02, Trafikolycka, Västerås',
    summary: 'Två bilar i trafikolycka.',
    url: '/aktuellt/handelser/2026/november/4/x/',
    type: 'Trafikolycka',
    location: { name: 'Västmanlands län', gps: '59.6,16.2' },
  },
];

/** Drive the plugin's middleware with a minimal req/res pair. */
function harness(options) {
  let route;
  let handler;
  const plugin = polisenEventsProxy(options);
  plugin.configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async (method = 'GET', url = '/') => {
    const res = {
      destroyed: false,
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method, url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
  return Object.assign(request, { route: () => route });
}

test('the gazetteer holds every Swedish municipality once, inside Sweden', () => {
  assert.equal(SWEDISH_MUNICIPALITIES.length, 290);
  const codes = SWEDISH_MUNICIPALITIES.map(([code]) => code);
  assert.equal(new Set(codes).size, 290);
  for (const [code, name, , lon, lat] of SWEDISH_MUNICIPALITIES) {
    assert.match(code, /^\d{4}$/);
    assert.ok(name, code);
    assert.ok(lon > 10.5 && lon < 24.5 && lat > 55 && lat < 69.5, name);
  }
});

test('one GET serves placed notices, then the 5-minute cache', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  let clock = Date.parse('2026-11-04T17:00:00Z');
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(PAYLOAD);
    },
  });
  assert.equal(request.route(), '/api/polisen-events');
  const first = await request();
  assert.equal(first.status, 200);
  const [row] = first.json().events;
  assert.equal(row.place, 'Västerås');
  assert.equal(row.precision, 'municipality');
  assert.deepEqual(row.point, [16.5422, 59.6173]);
  assert.equal(calls[0], POLISEN_EVENTS_URL);
  clock += 4 * 60_000;
  await request();
  assert.equal(calls.length, 1, 'served from the cache');
  clock += 2 * 60_000;
  await request();
  assert.equal(calls.length, 2, 'refreshed after 5 minutes');
});

test('a failed refresh serves the last snapshot marked stale, then gives up', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let fail = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : Response.json(PAYLOAD),
  });
  await request();
  fail = true;
  clock += 6 * 60_000;
  assert.equal((await request()).json().stale, true);
  clock += 2 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.equal(gone.json().error, 'polisen_events_unavailable');
});

test('after a failed refresh Polisen is left alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let fail = false;
  let calls = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail
        ? new Response('down', { status: 503 })
        : Response.json(PAYLOAD);
    },
  });
  await request();
  fail = true;
  clock += 6 * 60_000;
  const first = await request();
  assert.equal(first.json().stale, true);
  assert.equal(first.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 2);
  // Within the minute: the last snapshot again, Polisen not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1) {
    const again = await request();
    assert.equal(again.status, 200);
    assert.equal(again.headers['X-Data-Stale'], 'true');
  }
  assert.equal(calls, 2);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  fail = false;
  const back = await request();
  assert.equal(calls, 3);
  assert.equal(back.json().stale, undefined);
  assert.equal(back.headers['X-Data-Stale'], undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    now: () => Date.parse('2026-11-04T17:00:00Z'),
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'polisen_events_unavailable');
  assert.equal(calls, 1);
});

test('requests waiting on one fetch share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => (release = resolve));
      return Response.json(PAYLOAD);
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
    ['[polisen-events] 1 notices'],
  );
});
