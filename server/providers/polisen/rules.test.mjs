import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLISEN_MIN_GAP_MS,
  POLISEN_RETRY_AFTER_FAILURE_MS,
  POLISEN_RETRY_AFTER_RATE_LIMIT_MS,
  POLISEN_USER_AGENT,
  createPolisenGate,
  fetchPolisen,
  polisenRetryAfterMs,
} from './rules.js';
import { polisenEventsProxy } from '../polisenEvents.js';
import { policeStationsProxy } from '../policeStations.js';

test('calls to Polisen are at least ten seconds apart', async () => {
  let clock = 1_000_000;
  const waits = [];
  const gate = createPolisenGate({
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  await gate();
  await gate();
  clock += 3_000;
  await gate();
  clock += 60_000;
  await gate();
  assert.deepEqual(waits, [POLISEN_MIN_GAP_MS, POLISEN_MIN_GAP_MS - 3_000]);
});

test('every call names the app, and Polisen\'s answers set the pause', async () => {
  const seen = [];
  const answer = (status) => async (url, init) => {
    seen.push(init.headers['User-Agent']);
    return new Response(status === 200 ? '[]' : 'x', { status });
  };
  const free = async () => {};
  assert.equal((await fetchPolisen(answer(200), free, 'https://p/x')).status, 200);
  assert.match(POLISEN_USER_AGENT, /^GodsEyeViewSverige\/1\.0 /);
  assert.deepEqual(seen, [POLISEN_USER_AGENT]);
  await assert.rejects(fetchPolisen(answer(404), free, 'https://p/x'), {
    gone: true,
  });
  const limited = await fetchPolisen(answer(429), free, 'https://p/x').catch(
    (error) => error,
  );
  assert.equal(polisenRetryAfterMs(limited), POLISEN_RETRY_AFTER_RATE_LIMIT_MS);
  const down = await fetchPolisen(answer(503), free, 'https://p/x').catch(
    (error) => error,
  );
  assert.equal(polisenRetryAfterMs(down), POLISEN_RETRY_AFTER_FAILURE_MS);
});

/** One route of a proxy, driven with a minimal req/res pair. */
function route(proxy) {
  let handler;
  proxy.configureServer({ middlewares: { use: (_path, fn) => (handler = fn) } });
  return async () => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end() {},
    };
    await handler({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
    return res.status;
  };
}

test('after a 404 neither route asks Polisen again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const makeProxy of [polisenEventsProxy, policeStationsProxy]) {
    let clock = Date.parse('2026-11-12T10:00:00Z');
    let calls = 0;
    const request = route(
      makeProxy({
        now: () => clock,
        gate: async () => {},
        fetchImpl: async () => {
          calls += 1;
          return new Response('gone', { status: 404 });
        },
      }),
    );
    assert.equal(await request(), 502);
    clock += 3 * 24 * 60 * 60_000;
    assert.equal(await request(), 502);
    assert.equal(calls, 1);
  }
});

test('after a 429 Polisen is left alone for half an hour', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-12T10:00:00Z');
  let calls = 0;
  const request = route(
    polisenEventsProxy({
      now: () => clock,
      gate: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('slow down', { status: 429 });
      },
    }),
  );
  await request();
  clock += 29 * 60_000;
  await request();
  assert.equal(calls, 1);
  clock += 2 * 60_000;
  await request();
  assert.equal(calls, 2);
});
