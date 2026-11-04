import assert from 'node:assert/strict';
import test from 'node:test';

import { electricityPricesProxy } from './electricityPrices.js';

const FILE = [
  {
    SEK_per_kWh: 1.5,
    EUR_per_kWh: 0.137,
    EXR: 10.95,
    time_start: '2026-11-04T00:00:00+01:00',
    time_end: '2026-11-04T00:15:00+01:00',
  },
];

function harness(options) {
  let route;
  let handler;
  const plugin = electricityPricesProxy(options);
  plugin.configureServer({
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

test('eight day files make four zones; an unpublished tomorrow is empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  let clock = Date.parse('2026-11-04T10:00:00Z');
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes('11-05_')
        ? new Response('not yet', { status: 404 })
        : Response.json(FILE);
    },
  });
  assert.equal(request.route(), '/api/electricity-prices');
  const body = (await request()).json();
  assert.deepEqual(
    body.zones.map((zone) => [
      zone.id,
      zone.today.length,
      zone.tomorrow.length,
    ]),
    [
      ['SE1', 1, 0],
      ['SE2', 1, 0],
      ['SE3', 1, 0],
      ['SE4', 1, 0],
    ],
  );
  assert.equal(urls.length, 8);
  clock += 10 * 60_000;
  await request();
  assert.equal(urls.length, 8, 'cached for 15 minutes');
  clock += 6 * 60_000;
  await request();
  assert.equal(urls.length, 16, 'refreshed, e.g. for tomorrow’s auction');
});

test('a failure serves the last prices marked stale, then gives up', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-04T10:00:00Z');
  let fail = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 500 }) : Response.json(FILE),
  });
  await request();
  fail = true;
  clock += 20 * 60_000;
  assert.equal((await request()).json().stale, true);
  clock += 7 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
});
