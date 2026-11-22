// Swedish fork: /api/flights from adsb.lol on the shared daily budget, and
// the one transport GNSS integrity and /v2/mil share with it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adsbLolProxy } from './adsb-lol.js';
import { createAdsbLolUpstream } from './adsbLolUpstream.js';
import { gnssIntegrityProxy } from '../gnssIntegrity.js';

const START = Date.parse('2026-11-22T08:00:00Z');
const STOCKHOLM = '?lat=59.3300&lon=18.0700';
/** Another 0.25° cell, 28 km from Stockholm's disc: the same place. */
const NEARBY = '?lat=59.4500&lon=18.3000';
/** 91 km from Stockholm's disc: a new place, within its 250 nm. */
const VASTERAS = '?lat=59.6100&lon=16.5500';
/** About 500 km from Stockholm and Västerås: beyond a disc's 250 nm. */
const MALMO = '?lat=55.6000&lon=13.0000';
/** One call each for places far apart (no disc reaches another). */
const farPlace = (i) => `?lat=0.0000&lon=${(-170 + 20 * i).toFixed(4)}`;

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return async (route, url = '/') => {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method: 'GET', headers: {} }, response);
    return response;
  };
}

/**
 * A fresh flights route (the disc cache is module state) over a fake clock
 * and an adsb.lol transport whose fetch answers with `answer(call)`.
 */
async function setup(t, { answer, env = {} } = {}) {
  environment(t, { FLIGHTS_SOURCE: undefined });
  const clock = { now: START };
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  /** Whether each call went with a key. */
  const sent = [];
  const point = () =>
    Response.json({
      now: clock.now / 1000,
      ac: [{ hex: 'abc123', lat: 59.4, lon: 18.1, alt_baro: 10000 }],
    });
  const adsbLol = createAdsbLolUpstream({
    now: () => clock.now,
    env,
    warn: () => {},
    fetchImpl: async (url, init) => {
      calls.push(url);
      sent.push(init?.headers?.['x-api-key'] ? 'keyed' : 'keyless');
      return answer ? answer({ index: calls.length, point }) : point();
    },
  });
  const { openSkyProxy } = await import(`./opensky.js?budget=${Math.random()}`);
  return {
    clock,
    calls,
    sent,
    adsbLol,
    flights: install(openSkyProxy({ adsbLol })),
  };
}

test('an adsb.lol answer says the budget; the same place is paced, a new one asked at once', async (t) => {
  const { clock, calls, flights } = await setup(t);
  const first = await flights('/api/flights', STOCKHOLM);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(calls, [
    'https://api.adsb.lol/v2/lat/59.25/lon/18/dist/250',
  ]);
  assert.equal(first.headers['x-opensky-cache'], 'MISS');
  assert.equal(first.headers['x-adsblol-budget'], '1/450');
  assert.equal(first.headers['x-adsblol-keyed'], '0');
  assert.equal(first.headers['x-adsblol-key-refused'], undefined);
  assert.equal(first.headers['x-adsblol-locked-until'], undefined);
  assert.equal(first.headers['x-flight-age-seconds'], undefined);
  assert.equal(first.headers['x-adsblol-gap-seconds'], undefined);
  assert.equal(first.headers['x-flight-anchor'], '59.25,18.00');

  // Past the 12 s cache, inside the pacing gap: the flights' 360 of the
  // day's 450, paced at 90 %, one call per place every 266.7 s.
  clock.now += 20_000;
  const paced = await flights('/api/flights', STOCKHOLM);
  assert.equal(paced.headers['x-opensky-cache'], 'PACED');
  assert.equal(paced.headers['x-flight-age-seconds'], '20');
  assert.equal(paced.headers['x-adsblol-gap-seconds'], '267');
  assert.equal(paced.body, first.body);
  assert.equal(calls.length, 1, 'the paced disc costs no call');

  // Swedish fork: another cell within 50 km of a disc read within the gap
  // is the same place: that disc, paced, says where it was read.
  const near = await flights('/api/flights', NEARBY);
  assert.equal(near.headers['x-opensky-cache'], 'PACED');
  assert.equal(near.headers['x-flight-anchor'], '59.25,18.00');
  assert.equal(near.body, first.body);
  assert.equal(calls.length, 1, 'the same place costs no call');

  const moved = await flights('/api/flights', VASTERAS);
  assert.equal(moved.headers['x-opensky-cache'], 'MISS');
  assert.equal(moved.headers['x-adsblol-budget'], '2/450');
  assert.equal(moved.headers['x-flight-anchor'], '59.50,16.50');
  assert.equal(calls.length, 2, 'a new place is asked at once');

  clock.now += 240_000;
  assert.equal(
    (await flights('/api/flights', STOCKHOLM)).headers['x-opensky-cache'],
    'PACED',
    '260 s after: still inside the gap',
  );
  clock.now += 10_000;
  assert.equal(
    (await flights('/api/flights', STOCKHOLM)).headers['x-opensky-cache'],
    'MISS',
  );
  assert.equal(calls.length, 3, 'after the gap the place is asked again');
});

test('locked out by adsb.lol: the newest disc within 250 nm is served STALE, farther a 503 says until when', async (t) => {
  const { clock, calls, flights } = await setup(t, {
    answer: ({ index, point }) =>
      index === 1
        ? point()
        : new Response('{"detail":"quota"}', {
            status: 429,
            headers: { 'Retry-After': '3600' },
          }),
  });
  const first = await flights('/api/flights', STOCKHOLM);
  clock.now += 60_000;
  const until = new Date(START + 60_000 + 3_600_000).toISOString();
  const stale = await flights('/api/flights', VASTERAS);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body, first.body, "Stockholm's disc covers the place");
  assert.equal(stale.headers['x-opensky-cache'], 'STALE');
  assert.equal(stale.headers['x-flight-age-seconds'], '60');
  assert.equal(stale.headers['x-adsblol-locked-until'], until);
  assert.equal(stale.headers['x-adsblol-budget'], '2/450');

  const far = await flights('/api/flights', MALMO);
  assert.equal(far.statusCode, 503, 'never a bare 502');
  assert.equal(far.headers['retry-after'], '3600');
  assert.equal(far.headers['x-adsblol-locked-until'], until);
  assert.deepEqual(JSON.parse(far.body), {
    error: 'adsb.lol quota',
    lockedUntil: until,
  });
  // Stockholm's own disc is inside its pacing gap, yet the lock comes
  // first: the newest disc in reach, as STALE.
  const own = await flights('/api/flights', STOCKHOLM);
  assert.equal(own.headers['x-opensky-cache'], 'STALE');
  assert.equal(own.headers['x-adsblol-locked-until'], until);
  assert.equal(calls.length, 2, 'no call while locked');
});

test('a 200 says the quota is spent only for adsb.lol’s lock, or for a budget that frees later than the longest gap', async (t) => {
  // 10 a day: the flights' share is 8.
  const { clock, flights } = await setup(t, {
    env: { ADSBLOL_DAILY_BUDGET: '10' },
  });
  for (let i = 0; i < 7; i++) await flights('/api/flights', farPlace(i));
  // A day later, minus five minutes: one fresh disc, and the share spent.
  clock.now = START + 24 * 3_600_000 - 5 * 60_000;
  await flights('/api/flights', STOCKHOLM);
  const soon = await flights('/api/flights', VASTERAS);
  assert.equal(soon.headers['x-opensky-cache'], 'STALE');
  assert.equal(
    soon.headers['x-adsblol-locked-until'],
    undefined,
    'the budget frees in six minutes: no "quota used up"',
  );
  // With the share spent for most of a day, the 200 says so.
  const later = await setup(t, { env: { ADSBLOL_DAILY_BUDGET: '10' } });
  for (let i = 0; i < 7; i++) await later.flights('/api/flights', farPlace(i));
  await later.flights('/api/flights', STOCKHOLM);
  const spent = await later.flights('/api/flights', VASTERAS);
  assert.equal(spent.headers['x-opensky-cache'], 'STALE');
  assert.equal(
    spent.headers['x-adsblol-locked-until'],
    new Date(START + 24 * 3_600_000 + 60_000).toISOString(),
  );
});

test('a call on its way for a place is joined before the budget is checked', async (t) => {
  let release;
  const { calls, flights } = await setup(t, {
    env: { ADSBLOL_DAILY_BUDGET: '1' },
    answer: ({ point }) =>
      new Promise((resolve) => {
        release = () => resolve(point());
      }),
  });
  const first = flights('/api/flights', STOCKHOLM);
  await new Promise((resolve) => setImmediate(resolve));
  // The one call of the day is out: a second request for the place joins
  // it rather than being refused for want of budget.
  const second = flights('/api/flights', STOCKHOLM);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.headers['x-opensky-cache'], 'INFLIGHT');
  assert.equal(calls.length, 1);
});

test('over the day’s budget: the 503 says when the budget frees, and nothing is asked', async (t) => {
  const { calls, flights } = await setup(t, {
    env: { ADSBLOL_DAILY_BUDGET: '1' },
  });
  await flights('/api/flights', STOCKHOLM);
  const refused = await flights('/api/flights', MALMO);
  const frees = START + 24 * 3_600_000 + 60_000;
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.headers['x-adsblol-budget'], '1/1');
  assert.equal(refused.headers['retry-after'], String((frees - START) / 1000));
  assert.equal(
    JSON.parse(refused.body).lockedUntil,
    new Date(frees).toISOString(),
  );
  assert.equal(calls.length, 1);
});

test('a disc older than 30 minutes is not served, even for its own place', async (t) => {
  const { clock, flights } = await setup(t, {
    answer: ({ index, point }) =>
      index === 1 ? point() : new Response('', { status: 429 }),
  });
  await flights('/api/flights', STOCKHOLM);
  clock.now += 31 * 60_000;
  const old = await flights('/api/flights', STOCKHOLM);
  assert.equal(old.statusCode, 503);
  assert.equal(old.headers['retry-after'], String(15 * 60));
});

test('an outage: the refused body is dropped, a nearby disc is served STALE, else a 502 says when to try again', async (t) => {
  let cancelled = false;
  const { clock, calls, flights } = await setup(t, {
    answer: ({ index, point }) =>
      index === 1
        ? point()
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 503 },
          ),
  });
  const first = await flights('/api/flights', STOCKHOLM);
  clock.now += 30_000;
  const stale = await flights('/api/flights', VASTERAS);
  assert.equal(cancelled, true);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body, first.body);
  assert.equal(stale.headers['x-opensky-cache'], 'STALE');
  assert.equal(
    stale.headers['x-adsblol-locked-until'],
    undefined,
    'an outage is no quota lock',
  );
  const far = await flights('/api/flights', MALMO);
  assert.equal(far.statusCode, 502);
  assert.equal(far.headers['retry-after'], '60');
  assert.deepEqual(JSON.parse(far.body), { error: 'adsb.lol unavailable' });
  assert.equal(calls.length, 2, 'the flights caller is held back 60 s');
});

test('past the pace’s reserve a new place gets a disc in reach rather than a call, and is asked only with none in reach or none read within the gap', async (t) => {
  // 20 a day: the flights' share is 16, paced 14, evenly one every 103 min.
  // New places are asked at once while that pace keeps within twice its
  // even gap: here the first eight calls of a day.
  const { clock, calls, flights } = await setup(t, {
    env: { ADSBLOL_DAILY_BUDGET: '20' },
  });
  for (let i = 0; i < 7; i++) await flights('/api/flights', farPlace(i));
  await flights('/api/flights', MALMO);
  clock.now += 30_000;
  // Nothing in reach: asked rather than left dark.
  assert.equal(
    (await flights('/api/flights', STOCKHOLM)).headers['x-opensky-cache'],
    'MISS',
  );
  assert.equal(calls.length, 9);

  const west = await flights('/api/flights', VASTERAS);
  assert.equal(west.statusCode, 200);
  assert.equal(west.headers['x-opensky-cache'], 'STALE');
  assert.equal(west.headers['x-flight-anchor'], '59.25,18.00');
  assert.equal(
    west.headers['x-adsblol-locked-until'],
    undefined,
    'the budget is not spent',
  );
  // Malmö's disc is the nearer, though Stockholm's is the newer.
  const goteborg = await flights('/api/flights', '?lat=57.7000&lon=11.9700');
  assert.equal(goteborg.headers['x-opensky-cache'], 'STALE');
  assert.equal(goteborg.headers['x-flight-anchor'], '55.50,13.00');
  assert.equal(calls.length, 9, 'neither costs a call');

  // Past the gap (10 min, with the pace this tight) Stockholm's disc is no
  // longer the same place's; while a call went out within the gap anywhere,
  // the nearest disc in reach is served all the same, up to 30 min old.
  clock.now += 11 * 60_000;
  await flights('/api/flights', farPlace(7));
  assert.equal(calls.length, 10);
  const kept = await flights('/api/flights', STOCKHOLM);
  assert.equal(kept.headers['x-opensky-cache'], 'STALE');
  assert.equal(kept.headers['x-flight-age-seconds'], '660');
  // With no call within the gap, the place is asked again.
  clock.now += 10 * 60_000;
  const again = await flights('/api/flights', STOCKHOLM);
  assert.equal(again.headers['x-opensky-cache'], 'MISS');
  assert.equal(calls.length, 11);
});

test('a refused key: the next calls go without it, counted as such, and every answer says so while the refusal lasts', async (t) => {
  const { clock, sent, flights } = await setup(t, {
    env: { ADSBLOL_API_KEY: 'typo-key-123' },
    answer: ({ index, point }) =>
      index === 1
        ? new Response('{"detail":"invalid api key"}', { status: 401 })
        : point(),
  });
  const refused = await flights('/api/flights', STOCKHOLM);
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.headers['x-adsblol-key-refused'], '1');
  assert.equal(refused.headers['x-adsblol-keyed'], '0');
  assert.equal(
    refused.headers['retry-after'],
    '1',
    'nothing to wait for: the next call goes without the key',
  );
  const next = await flights('/api/flights', STOCKHOLM);
  assert.equal(next.statusCode, 200);
  assert.equal(next.headers['x-opensky-cache'], 'MISS');
  assert.equal(next.headers['x-adsblol-key-refused'], '1');
  assert.equal(next.headers['x-adsblol-budget'], '1/450');
  assert.deepEqual(sent, ['keyed', 'keyless']);
  // Once the refusal has run out, the key is tried again.
  clock.now += 15 * 60_000;
  const later = await flights('/api/flights', STOCKHOLM);
  assert.equal(later.headers['x-adsblol-key-refused'], undefined);
  assert.equal(later.headers['x-adsblol-keyed'], '1');
  assert.equal(later.headers['x-adsblol-budget'], '2/950');
  assert.deepEqual(sent, ['keyed', 'keyless', 'keyed']);
});

test('with no place yet the answer is empty, carries the budget and asks nothing', async (t) => {
  const { calls, flights } = await setup(t);
  const empty = await flights('/api/flights');
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(JSON.parse(empty.body).states, []);
  assert.equal(empty.headers['x-adsblol-budget'], '0/450');
  assert.equal(calls.length, 0);
});

test('one transport for every adsb.lol caller: a flights 429 stops GNSS and military aircraft too', async (t) => {
  const { clock, calls, adsbLol, flights } = await setup(t, {
    answer: () =>
      new Response('', { status: 429, headers: { 'Retry-After': '600' } }),
  });
  assert.equal((await flights('/api/flights', STOCKHOLM)).statusCode, 503);
  assert.equal(calls.length, 1);
  clock.now += 100_000;

  let gnssHandler;
  gnssIntegrityProxy({
    adsbLol,
    now: () => clock.now,
    monotonicNow: () => clock.now,
  }).configureServer({
    middlewares: { use: (route, handler) => (gnssHandler = handler) },
  });
  const gnss = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await gnssHandler(
    {
      url: '/?lat=59&lon=18',
      method: 'GET',
      socket: { remoteAddress: 'local' },
    },
    gnss,
  );
  assert.equal(gnss.status, 429);
  assert.equal(gnss.headers['Retry-After'], '500');

  const military = await install(adsbLolProxy({ adsbLol }))('/api/military');
  assert.equal(military.statusCode, 429);
  assert.equal(military.headers['retry-after'], '500');
  assert.equal(calls.length, 1, 'neither asked adsb.lol');
});

test('OpenSky mode’s adsb.lol fallback goes through the same transport', async (t) => {
  environment(t, {
    FLIGHTS_SOURCE: 'opensky',
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_CREDENTIALS_FILE: undefined,
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /opensky-network/);
    return new Response('', { status: 503 });
  });
  const adsbLol = createAdsbLolUpstream({
    env: {},
    warn: () => {},
    fetchImpl: async () =>
      Response.json({
        now: Date.now() / 1000,
        ac: [{ hex: 'abc123', lat: 59.4, lon: 18.1, alt_baro: 10000 }],
      }),
  });
  const { openSkyProxy } = await import(`./opensky.js?mode=${Math.random()}`);
  const answer = await install(openSkyProxy({ adsbLol }))(
    '/api/flights',
    STOCKHOLM,
  );
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.headers['x-flight-source'], 'adsb.lol');
  assert.equal(answer.headers['x-adsblol-budget'], '1/450');
  assert.equal(adsbLol.status().used, 1);
});

test('OpenSky mode: a stale OpenSky frame gives way only to a newer adsb.lol disc', async (t) => {
  environment(t, {
    FLIGHTS_SOURCE: 'opensky',
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_CREDENTIALS_FILE: undefined,
  });
  const clock = { now: START };
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let lagMs = 130_000;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /opensky-network/);
    return Response.json(
      {
        time: Math.floor((clock.now - lagMs) / 1000),
        states: [
          ['def456', 'SAS1', 'Sweden', null, null, 18.2, 59.5, 9000, false],
        ],
      },
      // Credits to spare: the frame is cached seconds, not minutes.
      { headers: { 'x-rate-limit-remaining': '3000' } },
    );
  });
  const adsbLol = createAdsbLolUpstream({
    now: () => clock.now,
    env: {},
    warn: () => {},
    fetchImpl: async () =>
      Response.json({
        now: clock.now / 1000,
        ac: [{ hex: 'abc123', lat: 59.4, lon: 18.1, alt_baro: 10000 }],
      }),
  });
  const { openSkyProxy } = await import(`./opensky.js?newer=${Math.random()}`);
  const flights = install(openSkyProxy({ adsbLol }));
  const fresh = await flights('/api/flights', STOCKHOLM);
  assert.equal(fresh.headers['x-flight-source'], 'adsb.lol');
  assert.equal(fresh.headers['x-opensky-cache'], 'MISS');
  // 200 s on, the paced disc is older than OpenSky's frame, 125 s old: the
  // frame is served, as before the fallback existed.
  clock.now += 200_000;
  lagMs = 125_000;
  const frame = await flights('/api/flights', STOCKHOLM);
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['x-flight-source'], undefined);
  assert.equal(
    JSON.parse(frame.body).time,
    Math.floor((clock.now - lagMs) / 1000),
  );
  assert.equal(adsbLol.status().used, 1);
});
