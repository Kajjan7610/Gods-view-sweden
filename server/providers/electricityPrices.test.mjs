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

/** A day file whose single quarter costs `sek`. */
const fileAt = (sek) => [{ ...FILE[0], SEK_per_kWh: sek }];
const todayOf = (body, zone) =>
  body.zones.find((entry) => entry.id === zone).today[0]?.sek;

test('a zone whose file fails keeps its prices while the others renew', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-04T10:00:00Z');
  let sek = 1.5;
  let se3Down = false;
  const urls = [];
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return se3Down && String(url).includes('_SE3')
        ? new Response('down', { status: 500 })
        : Response.json(fileAt(sek));
    },
  });
  await request();
  se3Down = true;
  sek = 2;
  clock += 16 * 60_000;
  const body = (await request()).json();
  assert.equal(todayOf(body, 'SE1'), 2);
  assert.equal(todayOf(body, 'SE3'), 1.5, 'the prices SE3 had');
  assert.equal(body.stale, undefined);
  assert.equal(urls.length, 16);
  // An answer missing a file is asked for again after five minutes, not 15.
  clock += 4 * 60_000;
  await request();
  assert.equal(urls.length, 16);
  se3Down = false;
  clock += 2 * 60_000;
  assert.equal(todayOf((await request()).json(), 'SE3'), 2);
  assert.equal(urls.length, 24);
});

test("after midnight yesterday's tomorrow is today, also when nothing can be fetched", async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // 23:30 in Stockholm on 4 November.
  let clock = Date.parse('2026-11-04T22:30:00Z');
  let fail = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) =>
      fail
        ? new Response('down', { status: 503 })
        : Response.json(fileAt(String(url).includes('11-05_') ? 3 : 1)),
  });
  const evening = (await request()).json();
  assert.equal(todayOf(evening, 'SE3'), 1);
  assert.equal(evening.zones[2].tomorrow[0].sek, 3);
  // 00:10 on 5 November, with elprisetjustnu.se down.
  fail = true;
  clock += 40 * 60_000;
  const night = (await request()).json();
  assert.equal(night.stale, true);
  assert.equal(night.day, '2026-11-05');
  assert.equal(todayOf(night, 'SE3'), 3, "the 5th's prices, not the 4th's");
  assert.deepEqual(night.zones[2].tomorrow, []);
});

test('after a failed refresh elprisetjustnu.se is left alone for five minutes', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-04T10:00:00Z');
  let fail = false;
  let calls = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail ? new Response('down', { status: 500 }) : Response.json(FILE);
    },
  });
  await request();
  fail = true;
  clock += 16 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(calls, 16);
  // The layer asks every minute: within the pause nothing is fetched.
  for (let i = 0; i < 4; i += 1) {
    clock += 60_000;
    assert.equal((await request()).json().stale, true);
  }
  assert.equal(calls, 16);
  clock += 2 * 60_000;
  fail = false;
  assert.equal((await request()).json().stale, undefined);
  assert.equal(calls, 24);
});

test('tomorrow is the next calendar day, also when a day is 23 or 25 hours', async (t) => {
  t.mock.method(console, 'log', () => {});
  const datesAt = async (iso) => {
    const urls = [];
    const request = harness({
      now: () => Date.parse(iso),
      fetchImpl: async (url) => {
        urls.push(String(url));
        return Response.json(FILE);
      },
    });
    await request();
    return [...new Set(urls.map((url) => url.match(/(\d\d-\d\d)_SE/)[1]))];
  };
  // 00:30 on 25 October 2026, a day of 25 hours: 24 hours on is still the 25th.
  assert.deepEqual(await datesAt('2026-10-24T22:30:00Z'), ['10-25', '10-26']);
  // 23:30 on 29 March 2026, a day of 23 hours: 24 hours on is the 31st.
  assert.deepEqual(await datesAt('2026-03-29T21:30:00Z'), ['03-29', '03-30']);
});

test('requests waiting on one refresh share it, logged once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = harness({
    now: () => Date.parse('2026-11-04T10:00:00Z'),
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json(FILE);
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
  assert.equal(calls, 8);
  assert.equal(log.mock.callCount(), 1);
});
