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
