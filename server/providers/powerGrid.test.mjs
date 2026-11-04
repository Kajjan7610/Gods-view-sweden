import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_URL, PRODUCTION_URL, powerGridProxy } from './powerGrid.js';

const NOW = Date.parse('2026-11-04T22:52:00Z');
const FLOW = {
  Data: [{ id: '1', data: [{ id: 'SE2_SE3', value: 5698.9 }] }],
  LastUpdated: NOW - 600_000,
};
const production = (y) => ({
  Data: y == null ? [] : [{ id: '1', data: [{ x: NOW - 900_000, y }] }],
});

function harness(fetchImpl) {
  let handler;
  powerGridProxy({ now: () => NOW, fetchImpl }).configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return async (url = '/') => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
}

test('flows and production arrive together, asked like the control-room page', async () => {
  const calls = [];
  const request = harness(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return Response.json(
      String(url).includes('/map/flow') ? FLOW : production(17468),
    );
  });
  const first = await request();
  assert.equal(first.status, 200);
  const body = first.json();
  assert.equal(body.links[0].mw, 5699);
  assert.equal(body.production.total, 17468);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      FLOW_URL(Date.parse('2026-11-04T22:45:00Z')),
      PRODUCTION_URL('2026-11-04'),
    ],
  );
  assert.match(calls[0].headers.Referer, /kontrollrummet/);
  await request();
  assert.equal(calls.length, 2, 'cached');
  assert.equal((await request('/other')).status, 404);
});

test('an empty new day falls back to yesterday’s production', async () => {
  const urls = [];
  const request = harness(async (url) => {
    urls.push(String(url));
    if (String(url).includes('/map/flow')) return Response.json(FLOW);
    return Response.json(
      production(String(url).includes('2026-11-04') ? null : 15000),
    );
  });
  const body = (await request()).json();
  assert.equal(body.production.total, 15000);
  assert.ok(urls.includes(PRODUCTION_URL('2026-11-03')));
});

test('an upstream failure is a 502 without a previous snapshot', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness(async () => new Response('<html>', { status: 403 }));
  assert.equal((await request()).status, 502);
});
