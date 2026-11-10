// The power-grid routes over ENTSO-E: off by default, a token kept private,
// the control room's answer shapes, a cache and a pause after failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { powerGridEntsoeProxy, powerGridProxyFor } from './powerGridEntsoe.js';
import { ENTSOE_AREAS } from '../../src/layers/powerGrid/entsoe.js';
import {
  entsoeAcknowledgement,
  entsoeDocument,
  entsoeSeries,
} from '../../src/layers/powerGrid/entsoeFixture.mjs';

const TOKEN = 'secret-token-1234';
const NOW = Date.parse('2026-11-10T11:20:00Z');
const CODE_OF = new Map(
  Object.entries(ENTSOE_AREAS).map(([area, code]) => [code, area]),
);

/** ENTSO-E as the proxy sees it: flows SE3→SE4 and DE→SE4, a flat Sweden. */
function fakeEntsoe({ fail = null, refuse = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const query = new URL(String(url)).searchParams;
    calls.push(query);
    if (fail) return new Response('down', { status: fail });
    if (refuse) return new Response('Unauthorized', { status: 401 });
    const type = query.get('documentType');
    const window = { start: '2026-11-10T10:00Z', end: '2026-11-10T11:00Z' };
    if (type === 'A11') {
      const from = CODE_OF.get(query.get('out_Domain'));
      const to = CODE_OF.get(query.get('in_Domain'));
      const mw = { 'SE3>SE4': 1200, 'DE>SE4': 400 }[`${from}>${to}`];
      if (mw == null)
        return new Response(entsoeAcknowledgement(), { status: 200 });
      return new Response(
        entsoeDocument([
          entsoeSeries({
            ...window,
            domain: 'flow',
            points: [
              [1, mw],
              [4, mw],
            ],
          }),
        ]),
      );
    }
    if (type === 'A75')
      return new Response(
        entsoeDocument([
          entsoeSeries({
            ...window,
            psrType: 'B12',
            inArea: query.get('in_Domain'),
            points: [
              [1, 1000],
              [2, 1000],
              [3, 1000],
              [4, 1000],
            ],
          }),
        ]),
      );
    if (type === 'A65')
      return new Response(
        entsoeDocument([
          entsoeSeries({
            ...window,
            outArea: query.get('outBiddingZone_Domain'),
            points: [
              [1, 900],
              [2, 900],
              [3, 900],
              [4, 900],
            ],
          }),
        ]),
      );
    return new Response('?', { status: 400 });
  };
  return { calls, fetchImpl };
}

function harness(proxy) {
  let handler;
  proxy.configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  return async (url = '/') => {
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
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
}

function quietLogs(t) {
  const lines = [];
  for (const level of ['log', 'warn'])
    t.mock.method(console, level, (...args) => lines.push(args.join(' ')));
  return lines;
}

test('the control room stays the source unless ENTSO-E is asked for', async (t) => {
  quietLogs(t);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response('down', { status: 503 });
  };
  await harness(powerGridProxyFor({}, { fetchImpl, now: () => NOW }))();
  assert.ok(urls.length && urls.every((url) => url.includes('svk.se')));
  urls.length = 0;
  const entsoe = harness(
    powerGridProxyFor(
      { POWER_GRID_SOURCE: 'EntsoE', ENTSOE_SECURITY_TOKEN: TOKEN },
      { fetchImpl, now: () => NOW },
    ),
  );
  await entsoe();
  assert.ok(urls.length && urls.every((url) => url.includes('entsoe.eu')));
});

test('without a token ENTSO-E is never asked', async (t) => {
  const lines = quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe();
  const request = harness(
    powerGridEntsoeProxy({ env: {}, fetchImpl, now: () => NOW }),
  );
  const answer = await request();
  assert.equal(answer.status, 503);
  assert.equal(answer.json().error, 'not_configured');
  assert.equal(calls.length, 0);
  assert.ok(lines.some((line) => line.includes('ENTSOE_SECURITY_TOKEN')));
});

test('one refresh answers the flows, production, the day and the week', async (t) => {
  const lines = quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe();
  let clock = NOW;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      now: () => clock,
    }),
  );
  const grid = await request();
  assert.equal(grid.status, 200);
  // Both directions of 14 links, generation and load in four zones.
  assert.equal(calls.length, 36);
  assert.ok(calls.every((query) => query.get('securityToken') === TOKEN));
  const body = grid.json();
  assert.equal(body.source, 'entsoe');
  assert.deepEqual(
    body.links.map(({ id, from, to, mw, kind }) => [id, from, to, mw, kind]),
    [
      ['DE_SE4', 'DE', 'SE4', 400, 'import'],
      ['SE3_SE4', 'SE3', 'SE4', 1200, 'internal'],
    ],
  );
  assert.deepEqual(body.production, {
    at: Date.parse('2026-11-10T10:45:00Z'),
    hydro: 4000,
    total: 4000,
    consumption: 3600,
    net: 400,
  });
  // The token is never answered or logged.
  assert.ok(!grid.body.includes(TOKEN));
  assert.ok(lines.every((line) => !line.includes(TOKEN)));

  const day = (await request('/day')).json();
  assert.equal(day.date, '2026-11-10');
  assert.equal(day.points.length, 4);
  assert.equal((await request('/day?date=2026-11-09')).status, 400);
  const week = (await request('/week')).json();
  assert.equal(week.days.length, 7);
  assert.equal(week.days.at(-1).date, '2026-11-10');
  assert.equal(week.days.at(-1).points.length, 4);
  assert.equal(calls.length, 36, 'the day and the week come from the cache');

  // A quarter-hour on, one refresh more.
  clock += 15 * 60_000;
  await request();
  assert.equal(calls.length, 72);
});

test('a failed refresh serves the last answer stale and pauses a minute', async (t) => {
  quietLogs(t);
  const live = fakeEntsoe();
  let fail = false;
  let calls = 0;
  let clock = NOW;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl: async (url) => {
        calls += 1;
        return fail
          ? new Response('down', { status: 503 })
          : live.fetchImpl(url);
      },
      now: () => clock,
    }),
  );
  await request();
  fail = true;
  clock += 16 * 60_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  const asked = calls;
  clock += 30_000;
  await request();
  assert.equal(calls, asked, 'ENTSO-E is left alone for a minute');
  clock += 2 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.equal(gone.json().keyRefused, false);
});

test('a refused token is reported, not sent again within the minute', async (t) => {
  const lines = quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe({ refuse: true });
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      now: () => NOW,
    }),
  );
  const first = await request();
  assert.equal(first.status, 502);
  assert.equal(first.json().keyRefused, true);
  const asked = calls.length;
  assert.equal((await request()).json().keyRefused, true);
  assert.equal(calls.length, asked);
  assert.ok(lines.every((line) => !line.includes(TOKEN)));
});
