import assert from 'node:assert/strict';
import test from 'node:test';

import { SR_TRAFFIC_URL, srTrafficProxy } from './srTraffic.js';

const PAYLOAD = {
  copyright: 'Copyright Sveriges Radio',
  messages: [
    {
      id: 7,
      priority: 3,
      createddate: '/Date(1793804400033+0100)/',
      title: 'Lv 148 Fårösund',
      latitude: 57.86,
      longitude: 19.05,
      category: 0,
      subcategory: 'Vägarbete',
    },
  ],
};

function harness(options) {
  let route;
  let handler;
  srTrafficProxy(options).configureServer({
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

test('one GET serves normalized messages, then the 3-minute cache', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  let clock = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return Response.json(PAYLOAD);
    },
  });
  assert.equal(request.route(), '/api/sr-traffic');
  const [row] = (await request()).json().messages;
  assert.equal(row.title, 'Lv 148 Fårösund');
  assert.deepEqual(urls, [SR_TRAFFIC_URL]);
  clock += 2 * 60_000;
  await request();
  assert.equal(urls.length, 1);
  clock += 2 * 60_000;
  await request();
  assert.equal(urls.length, 2);
});

test('a failure serves the last messages marked stale, then gives up', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = 0;
  let fail = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : Response.json(PAYLOAD),
  });
  await request();
  fail = true;
  clock += 4 * 60_000;
  assert.equal((await request()).json().stale, true);
  clock += 2 * 60 * 60_000;
  assert.equal((await request()).status, 502);
});

test('after a failed refresh SR is left alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00+01:00');
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
  clock += 4 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(calls, 2);
  // Within the minute: the last messages again, SR not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(calls, 2);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  fail = false;
  const back = await request();
  assert.equal(calls, 3);
  assert.equal(back.status, 200);
  assert.equal(back.json().stale, undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    now: () => Date.parse('2026-11-04T17:00:00+01:00'),
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'sr_traffic_unavailable');
  assert.equal(calls, 1);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls += 1;
      await gate;
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
    ['[sr-traffic] 1 messages'],
  );
});
