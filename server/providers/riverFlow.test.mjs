// The SMHI river flow route: SMHI is asked whether the data has changed
// before it is downloaded, at most every fifteen minutes; stale on failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SMHI_FLOW_PERIOD_URL,
  SMHI_FLOW_URL,
  riverFlowProxy,
} from './riverFlow.js';

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
const QUARTER = 15 * 60_000;
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

/**
 * SMHI as the route sees it: the period level with its update time, and the
 * data. `state.stamp` is that time (null: the period level names none),
 * `state.down` fails every request.
 */
function smhi(state = {}) {
  const asked = { period: 0, data: 0 };
  const fetchImpl = async (url) => {
    if (state.down) return new Response('down', { status: 503 });
    if (url === SMHI_FLOW_PERIOD_URL) {
      asked.period += 1;
      return Response.json({
        key: 'latest-hour',
        data: [{ key: 'latest-hour', updated: state.stamp ?? undefined }],
      });
    }
    assert.equal(url, SMHI_FLOW_URL);
    asked.data += 1;
    await state.gate;
    return Response.json(body);
  };
  return { asked, fetchImpl };
}

test('the route serves normalized stations and caches them', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const state = { stamp: NOW };
  const { asked, fetchImpl } = smhi(state);
  const get = route({ now: () => now, fetchImpl });
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.stations.map((row) => [row.name, row.flow]),
    [['Västersel', 34.8]],
  );
  assert.deepEqual(asked, { period: 1, data: 1 });
  now += 10 * 60_000;
  await get();
  assert.deepEqual(asked, { period: 1, data: 1 }, 'served from cache');
  state.down = true;
  now += 10 * 60_000;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
});

test('the data is downloaded again only when SMHI says it has changed', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const state = { stamp: NOW };
  const { asked, fetchImpl } = smhi(state);
  const get = route({ now: () => now, fetchImpl });
  const first = await get();
  // A quarter on, the same update time: asked, not downloaded.
  now += QUARTER;
  const same = await get();
  assert.deepEqual(asked, { period: 2, data: 1 });
  assert.deepEqual(same.body, first.body);
  assert.equal(same.body.stale, undefined);
  assert.equal(
    log.mock.calls.at(-1).arguments[0],
    '[river-flow] nothing new at SMHI',
  );
  // SMHI publishes the next hour: downloaded.
  state.stamp = NOW + 2 * QUARTER;
  now += QUARTER;
  const next = await get();
  assert.deepEqual(asked, { period: 3, data: 2 });
  assert.equal(next.body.fetchedAt, now);
  assert.equal(log.mock.calls.at(-1).arguments[0], '[river-flow] 1 stations');
  // An update time that never moves is believed for an hour, no longer.
  for (let i = 0; i < 3; i += 1) {
    now += QUARTER;
    await get();
  }
  assert.deepEqual(asked, { period: 6, data: 2 });
  now += QUARTER;
  await get();
  assert.deepEqual(asked, { period: 7, data: 3 });
  // A period level that names no time: downloaded each time, and said so.
  state.stamp = null;
  assert.equal(warn.mock.calls.length, 0);
  for (let i = 0; i < 2; i += 1) {
    now += QUARTER;
    await get();
  }
  assert.deepEqual(asked, { period: 9, data: 5 });
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[river-flow] SMHI names no update time',
  );
});

test('after a failed refresh SMHI is left alone for a minute', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  const state = { stamp: NOW };
  let calls = 0;
  const { fetchImpl } = smhi(state);
  const get = route({
    now: () => clock,
    fetchImpl: (url) => {
      calls += 1;
      return fetchImpl(url);
    },
  });
  await get();
  state.down = true;
  clock += 16 * 60_000;
  assert.equal((await get()).body.stale, true);
  const afterFailure = calls;
  // Within the minute: the last stations again, SMHI not asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1) assert.equal((await get()).body.stale, true);
  assert.equal(calls, afterFailure);
  // After it, asked once more; and once it answers, fresh again.
  clock += 31_000;
  state.down = false;
  state.stamp = NOW + QUARTER;
  const back = await get();
  assert.ok(calls > afterFailure);
  assert.equal(back.body.stale, undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const get = route({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await get()).status, 502);
  const afterFailure = calls;
  const paused = await get();
  assert.equal(paused.status, 502);
  assert.equal(paused.body.error, 'river_flow_unavailable');
  assert.equal(calls, afterFailure);
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const state = {
    stamp: NOW,
    gate: new Promise((resolve) => (release = resolve)),
  };
  const { asked, fetchImpl } = smhi(state);
  const get = route({ now: () => NOW, fetchImpl });
  const waiting = [get(), get(), get()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.deepEqual(asked, { period: 1, data: 1 });
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ['[river-flow] 1 stations'],
  );
});
