// The SMHI river flow route: one station-set read per fifteen minutes,
// stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SMHI_FLOW_URL, riverFlowProxy } from './riverFlow.js';

function route(options) {
  let handler = null;
  riverFlowProxy(options).configureServer({
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
  station: [
    {
      key: '1583',
      name: 'VÄSTERSEL',
      catchmentName: 'MOÄLVEN',
      catchmentSize: 1465.2,
      latitude: 63.4332,
      longitude: 18.3034,
      value: [{ date: NOW - 9e5, value: 34.8, quality: 'O' }],
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
    first.body.stations.map((row) => [row.name, row.flow]),
    [['Västersel', 34.8]],
  );
  assert.deepEqual(calls, [SMHI_FLOW_URL]);
  now += 10 * 60_000;
  await get();
  assert.equal(calls.length, 1, 'served from cache');
  now += 10 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
});
