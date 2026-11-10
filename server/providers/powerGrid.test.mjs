// The control-room route: one flows and one production read per five
// minutes, a pause after a failure, and calendar days kept for the week.
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FLOW_URL,
  POWER_GRID_RETRY_AFTER_FAILURE_MS,
  PRODUCTION_URL,
  powerGridProxy,
  stepDate,
} from './powerGrid.js';

/** 23:52 in Stockholm on 4 November. */
const NOW = Date.parse('2026-11-04T22:52:00Z');
const TTL_MS = 5 * 60_000;
const STALE_MAX_MS = 2 * 60 * 60_000;
const FLOW = {
  Data: [{ id: '1', data: [{ id: 'SE2_SE3', value: 5698.9 }] }],
  LastUpdated: NOW - 600_000,
};
const production = (y, at = NOW - 900_000) => ({
  Data: y == null ? [] : [{ id: '1', data: [{ x: at, y }] }],
});
const isFlow = (url) => String(url).includes('/map/flow');

/** A fresh day store per harness, removed when the run ends. */
const dirs = [];
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-power-'));
  dirs.push(dir);
  return dir;
}

function keepDay(dir, date, points) {
  writeFileSync(
    path.join(dir, `${date}.json`),
    JSON.stringify({ date, points }),
  );
}

function harness(
  fetchImpl,
  { cacheDir = tempDir(), now = () => NOW, schedule = () => null } = {},
) {
  let handler;
  powerGridProxy({ now, fetchImpl, cacheDir, schedule }).configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method, url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
}

/** A control room that counts what it is asked and can be switched off. */
function controlRoom(day = () => production(17468)) {
  const room = {
    urls: [],
    down: false,
    productionDown: false,
    get flows() {
      return room.urls.filter(isFlow).length;
    },
    get productions() {
      return room.urls.length - room.flows;
    },
    fetch: async (url) => {
      room.urls.push(String(url));
      if (room.down || (room.productionDown && !isFlow(url)))
        return new Response('<html>', { status: 403 });
      return Response.json(isFlow(url) ? FLOW : day(String(url)));
    },
  };
  return room;
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
  assert.equal(body.fetchedAt, NOW);
  assert.equal(body.stale, undefined);
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

test('a cold / and /day together make one production request', async () => {
  const room = controlRoom();
  const request = harness(room.fetch);
  const [grid, day] = await Promise.all([request(), request('/day')]);
  assert.equal(grid.json().production.total, 17468);
  assert.equal(day.json().points.length, 1);
  assert.equal((await request('/week')).json().days.at(-1).points.length, 1);
  assert.equal(room.productions, 1);
  assert.equal(room.flows, 1);
});

test('an answer is kept five minutes from the start of its read', async () => {
  let now = NOW;
  const room = controlRoom();
  const request = harness(room.fetch, { now: () => now });
  await request();
  await request('/day');
  now += TTL_MS - 1;
  await request();
  await request('/day');
  assert.equal(room.urls.length, 2, 'still kept');
  now += 1;
  assert.equal((await request('/day')).json().stale, undefined);
  assert.equal(room.productions, 2, 'a client polling every TTL reads anew');
  assert.equal((await request()).json().stale, undefined);
  assert.deepEqual([room.flows, room.productions], [2, 2]);
});

test('an empty new day shows the evening before, and asks for no past date', async () => {
  const midnight = Date.parse('2026-11-04T23:05:00Z'); // 00:05 on 5 November
  const dir = tempDir();
  keepDay(dir, '2026-11-04', [
    { at: midnight - 35 * 60_000, total: 15000, nuclear: 3000 },
    { at: midnight - 20 * 60_000, total: 15100, wind: 9000 },
    { at: midnight - 5 * 60_000, consumption: 16000 },
  ]);
  const room = controlRoom(() => production(null));
  const request = harness(room.fetch, { cacheDir: dir, now: () => midnight });
  assert.deepEqual((await request()).json().production, {
    at: midnight - 20 * 60_000,
    total: 15100,
    wind: 9000,
  });
  assert.deepEqual(room.urls, [
    FLOW_URL(Date.parse('2026-11-04T23:00:00Z')),
    PRODUCTION_URL('2026-11-05'),
  ]);

  // Nothing kept from the evening: production without values.
  const bare = controlRoom(() => production(null));
  const body = (await harness(bare.fetch, { now: () => midnight })()).json();
  assert.equal(body.links.length, 1);
  assert.deepEqual(body.production, { at: null });
  assert.equal(body.stale, undefined);
  assert.deepEqual(bare.urls.slice(1), [PRODUCTION_URL('2026-11-05')]);
});

test('past midnight the last production seen stays until the new day has one', async () => {
  let now = NOW;
  const room = controlRoom((url) =>
    production(url.includes('2026-11-04') ? 17468 : null),
  );
  const request = harness(room.fetch, { now: () => now });
  await request();
  now += 15 * 60_000; // 00:07 on 5 November
  const body = (await request()).json();
  assert.deepEqual(body.production, { at: NOW - 900_000, total: 17468 });
  assert.equal(room.urls.at(-1), PRODUCTION_URL('2026-11-05'));
  // Old values are not shown for ever.
  now += STALE_MAX_MS;
  assert.deepEqual((await request()).json().production, { at: null });
  assert.ok(room.urls.every((url) => !url.includes('2026-11-03')));
});

test('an upstream failure is a 502 without a previous snapshot', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness(async () => new Response('<html>', { status: 403 }));
  const res = await request();
  assert.equal(res.status, 502);
  assert.equal(res.json().error, 'power_grid_unavailable');
});

test('after a failed refresh the control room is left alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const room = controlRoom();
  const request = harness(room.fetch, { now: () => now });
  await request();
  room.down = true;
  now += TTL_MS;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.json().fetchedAt, NOW, 'the time of the last good read');
  assert.equal(room.urls.length, 4);
  now += POWER_GRID_RETRY_AFTER_FAILURE_MS - 1;
  for (const url of ['/', '/day', '/week', '/', '/day']) {
    const paused = await request(url);
    assert.equal(paused.status, 200);
    assert.equal(paused.json().stale, true, url);
  }
  assert.equal(room.urls.length, 4, 'no new read during the pause');
  room.down = false;
  now += 1;
  assert.equal((await request()).json().stale, undefined);
  assert.equal((await request('/day')).json().stale, undefined);
  assert.equal(room.urls.length, 6, 'the pause is over');
});

test('a failure without a cache pauses too, and answers 502 meanwhile', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const room = controlRoom();
  room.down = true;
  const request = harness(room.fetch, { now: () => now });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await request()).status, 502);
    const day = await request('/day');
    assert.equal(day.status, 502);
    assert.equal(day.json().error, 'power_grid_day_unavailable');
  }
  assert.deepEqual([room.flows, room.productions], [1, 1]);
  const week = await request('/week');
  assert.equal(week.status, 200);
  assert.equal(week.json().days.length, 7);
  assert.equal(room.urls.length, 2);
  now += POWER_GRID_RETRY_AFTER_FAILURE_MS;
  assert.equal((await request()).status, 502);
  assert.deepEqual([room.flows, room.productions], [2, 2]);
});

test('flows are answered when only production failed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const room = controlRoom();
  const request = harness(room.fetch, { now: () => now });
  await request();
  room.productionDown = true;
  now += TTL_MS;
  const res = await request();
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.stale, undefined, 'the flows are fresh');
  assert.equal(body.fetchedAt, now);
  assert.equal(body.links[0].mw, 5699);
  assert.deepEqual(body.production, { at: NOW - 900_000, total: 17468 });
  // Production pauses on its own; the day is the last one, marked stale.
  const day = await request('/day');
  assert.equal(day.json().stale, true);
  assert.equal(day.json().points.length, 1);
  assert.deepEqual([room.flows, room.productions], [2, 2]);

  // With nothing seen before, the flows come with no production values.
  const cold = controlRoom();
  cold.productionDown = true;
  const first = await harness(cold.fetch)();
  assert.equal(first.status, 200);
  assert.equal(first.json().links.length, 1);
  assert.deepEqual(first.json().production, { at: null });
});

test('the day route answers today’s quarter-hours and no other day', async () => {
  const calls = [];
  const request = harness(async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        Data: [
          {
            id: '1',
            data: [
              { x: NOW - 1_800_000, y: 17000 },
              { x: NOW - 900_000, y: 17100 },
            ],
          },
          {
            id: '7',
            data: [
              { x: NOW - 1_800_000, y: 18000 },
              { x: NOW - 900_000, y: 18200 },
            ],
          },
          {
            id: '8',
            data: [
              { x: NOW - 1_800_000, y: -1000 },
              { x: NOW - 900_000, y: null },
            ],
          },
        ],
      }),
    );
  });
  const today = await request('/day');
  assert.equal(today.status, 200);
  const body = today.json();
  assert.equal(body.date, '2026-11-04');
  assert.deepEqual(body.points, [
    { at: NOW - 1_800_000, total: 17000, consumption: 18000, net: -1000 },
    { at: NOW - 900_000, total: 17100, consumption: 18200 },
  ]);
  assert.equal(body.stale, undefined);
  assert.equal(calls.at(-1), PRODUCTION_URL('2026-11-04'));
  await request('/day?date=2026-11-04');
  assert.equal(calls.length, 1, 'served from cache');
  // The control room serves the current day only.
  assert.equal((await request('/day?date=2026-11-03')).status, 400);
  assert.equal((await request('/day?date=2026-10-01')).status, 400);
  assert.equal((await request('/day?date=2026-11-05')).status, 400);
  assert.equal(calls.length, 1);
});

test('a failed day is served stale for two hours, then not at all', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW - 3 * 60 * 60_000; // 20:52, so the date stays the same
  const start = now;
  const room = controlRoom();
  const request = harness(room.fetch, { now: () => now });
  assert.equal((await request('/day')).json().stale, undefined);
  room.down = true;
  now = start + TTL_MS;
  const stale = (await request('/day')).json();
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, start);
  assert.equal(stale.points.length, 1);
  now = start + STALE_MAX_MS;
  assert.equal((await request('/day')).json().stale, true);
  now += 1;
  const gone = await request('/day');
  assert.equal(gone.status, 502);
  assert.equal(gone.json().error, 'power_grid_day_unavailable');
});

test('the empty answer of a new day is kept like any other', async () => {
  let now = Date.parse('2026-11-04T23:05:00Z'); // 00:05 on 5 November
  let answer = production(null);
  const room = controlRoom(() => answer);
  const request = harness(room.fetch, { now: () => now });
  for (let i = 0; i < 3; i += 1) {
    const day = await request('/day');
    assert.equal(day.status, 200);
    assert.equal(day.json().date, '2026-11-05');
    assert.deepEqual(day.json().points, []);
    assert.equal(day.json().stale, undefined);
    const week = (await request('/week')).json();
    assert.deepEqual(week.days.at(-1), { date: '2026-11-05', points: [] });
    assert.equal(week.stale, undefined);
  }
  assert.equal(room.productions, 1, 'not asked again on every request');
  now += TTL_MS;
  answer = production(16000, now - 60_000);
  assert.equal((await request('/day')).json().points.length, 1);
  assert.equal(room.productions, 2);
  // An empty answer later the same day does not drop the points held.
  now += TTL_MS;
  answer = production(null);
  const day = (await request('/day')).json();
  assert.equal(day.points.length, 1);
  assert.equal(day.stale, undefined);
  assert.equal((await request()).json().production.total, 16000);
  assert.equal(room.productions, 3);
});

test('at midnight the held day is yesterday’s, never today’s', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW;
  const room = controlRoom((url) =>
    production(url.includes('2026-11-04') ? 17468 : null),
  );
  const request = harness(room.fetch, { now: () => now });
  assert.equal((await request('/day')).json().points.length, 1);
  now += 10 * 60_000; // 00:02 on 5 November
  const day = (await request('/day')).json();
  assert.equal(day.date, '2026-11-05');
  assert.deepEqual(day.points, []);
  assert.equal(room.urls.at(-1), PRODUCTION_URL('2026-11-05'));
  const week = (await request('/week')).json();
  assert.deepEqual(
    week.days.slice(-2).map((entry) => [entry.date, entry.points.length]),
    [
      ['2026-11-04', 1],
      ['2026-11-05', 0],
    ],
  );

  // The same with the control room down as the day turns.
  let later = NOW;
  const dark = controlRoom();
  const ask = harness(dark.fetch, { now: () => later });
  await ask('/day');
  dark.down = true;
  later += 10 * 60_000;
  assert.equal((await ask('/day')).status, 502);
  const kept = (await ask('/week')).json();
  assert.equal(kept.stale, true);
  assert.deepEqual(
    kept.days.slice(-2).map((entry) => [entry.date, entry.points.length]),
    [
      ['2026-11-04', 1],
      ['2026-11-05', 0],
    ],
  );
  assert.deepEqual(
    dark.urls,
    [PRODUCTION_URL('2026-11-04'), PRODUCTION_URL('2026-11-05')],
    'one read per date, none for a past date',
  );
});

test('the week puts kept days beside today, and keeps today for later', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = tempDir();
  const point = (at, total) => ({ at, total });
  // Two days kept earlier; one too old to show.
  keepDay(dir, '2026-11-02', [point(NOW - 2 * 86_400_000, 15000)]);
  keepDay(dir, '2026-10-20', [point(1, 1)]);
  const request = harness(
    async () =>
      new Response(
        JSON.stringify({
          Data: [{ id: '1', data: [{ x: NOW - 900_000, y: 17100 }] }],
        }),
      ),
    { cacheDir: dir },
  );
  const week = (await request('/week')).json();
  assert.deepEqual(
    week.days.map((day) => day.date),
    [
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ],
  );
  assert.deepEqual(
    week.days.map((day) => day.points.length),
    [0, 0, 0, 0, 1, 0, 1],
  );
  assert.equal(week.fetchedAt, NOW);
  assert.equal(week.stale, undefined);
  // Today went to disk, and the old day was cleared away.
  const again = harness(async () => new Response('', { status: 403 }), {
    cacheDir: dir,
  });
  const kept = (await again('/week')).json();
  assert.equal(kept.days.at(-1).points[0].total, 17100);
  assert.equal(kept.stale, true, 'today could not be read anew');
  assert.ok(!readdirSync(dir).includes('2026-10-20.json'));
});

test('the week is seven calendar dates across a clock change', async () => {
  const dates = async (iso) => {
    const request = harness(controlRoom().fetch, {
      now: () => Date.parse(iso),
    });
    return (await request('/week')).json().days.map((day) => day.date);
  };
  // The day after the autumn change: 25 October had 25 hours.
  assert.deepEqual(await dates('2026-10-26T22:30:00Z'), [
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);
  // After the spring change: 29 March had 23 hours. 00:30 on 1 April.
  assert.deepEqual(await dates('2026-03-31T22:30:00Z'), [
    '2026-03-26',
    '2026-03-27',
    '2026-03-28',
    '2026-03-29',
    '2026-03-30',
    '2026-03-31',
    '2026-04-01',
  ]);
  assert.equal(stepDate('2026-03-01', -1), '2026-02-28');
  assert.equal(stepDate('2028-02-28', 1), '2028-02-29');
  assert.equal(stepDate('2026-12-31', 1), '2027-01-01');
  assert.equal(stepDate('2026-11-04', 0), '2026-11-04');
});

test('days on disk are pruned by date across a clock change', async () => {
  const dir = tempDir();
  // Eight days are kept: 19 October is the oldest on the 26th.
  keepDay(dir, '2026-10-18', [{ at: 1, total: 1 }]);
  keepDay(dir, '2026-10-19', [{ at: 2, total: 2 }]);
  const request = harness(controlRoom().fetch, {
    cacheDir: dir,
    now: () => Date.parse('2026-10-26T22:30:00Z'),
  });
  await request('/day');
  assert.deepEqual(readdirSync(dir).sort(), [
    '2026-10-19.json',
    '2026-10-26.json',
  ]);
});

test('a shorter answer never overwrites a longer day on disk', async () => {
  const dir = tempDir();
  const file = path.join(dir, '2026-11-04.json');
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).points.length;
  // Kept by an earlier run of the server.
  keepDay(dir, '2026-11-04', [
    { at: NOW - 2_700_000, total: 1 },
    { at: NOW - 1_800_000, total: 2 },
  ]);
  let now = NOW;
  let answer = production(17468);
  const request = harness(controlRoom(() => answer).fetch, {
    cacheDir: dir,
    now: () => now,
  });
  await request('/day');
  assert.equal(saved(), 2, 'one point does not replace two');
  now += TTL_MS;
  answer = {
    Data: [
      {
        id: '1',
        data: [1, 2, 3].map((i) => ({ x: NOW - i * 900_000, y: 17000 + i })),
      },
    ],
  };
  await request('/day');
  assert.equal(saved(), 3);
  now += TTL_MS;
  answer = production(17468);
  await request('/day');
  assert.equal(saved(), 3);
});

test('the quarter-hourly save shares the read and keeps the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = NOW - 60 * 60_000;
  const ticks = [];
  const room = controlRoom();
  const request = harness(room.fetch, {
    now: () => now,
    schedule: (fn, ms) => ticks.push({ fn, ms }),
  });
  await request('/day');
  await request();
  await request('/week');
  assert.equal(ticks.length, 1, 'armed once');
  assert.equal(ticks[0].ms, 15 * 60_000);
  ticks[0].fn();
  assert.equal(room.productions, 1, 'nothing to do while the day is fresh');
  now += 15 * 60_000;
  ticks[0].fn();
  await request('/day');
  assert.equal(room.productions, 2, 'the request joined the save’s read');
  room.down = true;
  now += 15 * 60_000;
  ticks[0].fn();
  assert.equal((await request('/day')).json().stale, true);
  assert.equal(room.productions, 3);
  now += POWER_GRID_RETRY_AFTER_FAILURE_MS - 1;
  ticks[0].fn();
  await request('/day');
  assert.equal(room.productions, 3, 'left alone during the pause');
});

test('only GET is answered, and a client is held to thirty reads a minute', async () => {
  let now = NOW - 6 * 60 * 60_000;
  const room = controlRoom();
  const request = harness(room.fetch, { now: () => now });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal(room.urls.length, 0);
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await request(i % 2 ? '/day' : '/')).status, 200);
    now += TTL_MS;
  }
  const asked = room.urls.length;
  for (const url of ['/', '/day']) {
    const limited = await request(url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['Retry-After'], '60');
  }
  // The week answers with what is held instead.
  const week = await request('/week');
  assert.equal(week.status, 200);
  assert.equal(week.json().stale, true);
  assert.equal(room.urls.length, asked, 'nothing asked beyond the limit');
});
