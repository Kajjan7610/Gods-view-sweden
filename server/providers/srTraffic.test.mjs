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
