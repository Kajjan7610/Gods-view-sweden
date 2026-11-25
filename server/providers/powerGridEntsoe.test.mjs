// The power-grid routes over ENTSO-E: off by default, a token kept private,
// the control room's answer shapes, a cache and a pause after failure, the
// last answer served at once while a refresh runs, and kept across a restart.
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { powerGridEntsoeProxy } from './powerGridEntsoe.js';
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

/** A file of the test's own for the answer kept on disk. */
async function cacheFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-power-grid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'power-grid-entsoe.json');
}

/** The answer kept on disk, or null without one. */
const savedAnswer = (file) =>
  readFile(file, 'utf8').then(JSON.parse, () => null);

/**
 * The answer as the proxy saved it the `nth` time, read once the spied
 * rename that put it in place has settled. Waiting never opens the file:
 * on Windows a file held open cannot be replaced, and the save would fail.
 */
async function nthSave(rename, file, nth) {
  const moves = () =>
    rename.mock.calls.filter((call) => call.arguments[1] === file);
  for (let waited = 0; moves().length < nth && waited < 5000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const move = moves()[nth - 1];
  assert.ok(move, `saved ${nth} times`);
  await move.result;
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Wait, however busy the machine is, until `done()` holds. */
async function until(done) {
  for (let waited = 0; !(await done()) && waited < 5000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await done(), 'waited too long');
}

/** The answer if it comes within two seconds, else null. */
const answeredAtOnce = (answer) =>
  Promise.race([
    answer,
    new Promise((resolve) => setTimeout(resolve, 2000, null).unref()),
  ]);

test('without a token ENTSO-E is not asked', async (t) => {
  quietLogs(t);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response('down', { status: 503 });
  };
  const keyless = await harness(
    powerGridEntsoeProxy({ env: {}, fetchImpl, now: () => NOW }),
  )();
  assert.equal(keyless.status, 503);
  assert.deepEqual(urls, []);
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
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  let clock = NOW;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN, ENTSOE_PRODUCTION: 'on' },
      fetchImpl,
      now: () => clock,
      cachePath,
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

  // A quarter-hour on, the last answer comes at once, marked stale, and one
  // refresh more runs behind it.
  clock += 15 * 60_000;
  const due = await request();
  assert.equal(due.json().stale, true);
  assert.equal(due.json().fetchedAt, NOW);
  assert.equal((await nthSave(rename, cachePath, 2)).at, clock);
  assert.equal(calls.length, 72);
  assert.equal((await request()).json().fetchedAt, clock);
});

test("a failed refresh serves the last answer stale and pauses a minute, or until the layer's early read is in", async (t) => {
  const lines = quietLogs(t);
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
      cachePath: await cacheFile(t),
    }),
  );
  await request();
  fail = true;
  clock += 16 * 60_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  assert.equal(stale.json().refreshing, true, 'a refresh runs for it');
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  // The one refresh behind it fails at once…
  await until(() => lines.some((line) => line.includes('refresh failed')));
  const asked = calls;
  assert.equal(asked, 28 + 28);
  // …and ENTSO-E is left alone for a minute, the last answer served, with
  // no refresh running for it now.
  clock += 30_000;
  const paused = (await request()).json();
  assert.equal(paused.stale, true);
  assert.equal(paused.refreshing, undefined);
  assert.equal(calls, asked, 'ENTSO-E is left alone for a minute');
  // The layer's read 90 s after the answer that said `refreshing` comes
  // after that minute, yet asks ENTSO-E nothing either.
  clock += 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal(calls, asked, 'the early read never asks ENTSO-E');
  // Two minutes after that answer the next poll asks again.
  clock += 31_000;
  assert.equal((await request()).json().refreshing, true);
  await until(
    () => lines.filter((line) => line.includes('refresh failed')).length === 2,
  );
  assert.equal(calls, asked + 28);
  clock += 2 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.equal(gone.json().keyRefused, false);
});

test('an answer past its quarter-hour is served at once while one refresh runs behind it', async (t) => {
  quietLogs(t);
  const live = fakeEntsoe();
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  const state = { now: NOW, gate: null };
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl: async (url) => {
        await state.gate;
        return live.fetchImpl(url);
      },
      now: () => state.now,
      cachePath,
    }),
  );
  await request();
  assert.equal(live.calls.length, 28);
  // ENTSO-E is slow to answer now; three requests are answered all the
  // same, with the last answer, and share one refresh.
  let release;
  state.gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  state.now += 20 * 60_000;
  for (let i = 0; i < 3; i += 1) {
    const answer = await answeredAtOnce(request());
    assert.ok(answer, 'answered before ENTSO-E has answered');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['X-Data-Stale'], 'true');
    assert.equal(answer.json().stale, true);
    assert.equal(answer.json().refreshing, true);
    assert.equal(answer.json().fetchedAt, NOW);
  }
  release();
  assert.equal((await nthSave(rename, cachePath, 2)).at, state.now);
  assert.equal(live.calls.length, 28 + 28, 'one refresh of 28 requests');
  const fresh = await request();
  assert.equal(fresh.json().stale, undefined);
  assert.equal(fresh.json().refreshing, undefined);
  assert.equal(fresh.json().fetchedAt, state.now);
  assert.equal(live.calls.length, 28 + 28);
});

test('an answer at its two hours is served stale at once, not lost a millisecond later', async (t) => {
  quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe();
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  let clock = NOW;
  let step = 0;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      // Once stepping, each look at the clock is a millisecond on.
      now: () => {
        const at = clock;
        clock += step;
        return at;
      },
      cachePath,
    }),
  );
  await request();
  clock = NOW + 2 * 60 * 60_000;
  step = 1;
  const edge = await request();
  assert.equal(edge.status, 200);
  assert.equal(edge.json().stale, true);
  assert.equal(edge.json().fetchedAt, NOW);
  assert.ok((await nthSave(rename, cachePath, 2)).at > NOW);
  assert.equal(calls.length, 28 + 28);
});

test('a restart within the quarter-hour answers from disk and asks ENTSO-E nothing', async (t) => {
  const lines = quietLogs(t);
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  const proxy = (fetchImpl, at) =>
    harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: TOKEN },
        fetchImpl,
        now: () => at,
        cachePath,
      }),
    );
  const before = fakeEntsoe();
  const first = await proxy(before.fetchImpl, NOW)();
  assert.equal(before.calls.length, 28);
  // Written beside the file and moved over it, never with the token.
  const moves = rename.mock.calls
    .map((call) => call.arguments)
    .filter(([, to]) => to === cachePath);
  assert.equal(moves.length, 1);
  const [[from]] = moves;
  assert.equal(path.dirname(from), path.dirname(cachePath));
  assert.notEqual(from, cachePath);
  assert.deepEqual(await readdir(path.dirname(cachePath)), [
    path.basename(cachePath),
  ]);
  assert.ok(!(await readFile(cachePath, 'utf8')).includes(TOKEN));
  // A key saved in KOPPLA PÅ restarts the server: a new proxy, the same
  // file, ten minutes on.
  const after = fakeEntsoe();
  const again = await proxy(after.fetchImpl, NOW + 10 * 60_000)();
  assert.equal(again.status, 200);
  assert.deepEqual(again.json(), first.json());
  assert.equal(again.json().fetchedAt, NOW);
  assert.equal(after.calls.length, 0, 'ENTSO-E is not asked');
  assert.ok(lines.every((line) => !line.includes(TOKEN)));
});

test('a restart with another key tries it at once, and says a refusal at once', async (t) => {
  const lines = quietLogs(t);
  const cachePath = await cacheFile(t);
  const NEW_TOKEN = 'another-token-5678';
  const proxy = (token, fetchImpl, at) =>
    harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: token },
        fetchImpl,
        now: () => at,
        cachePath,
      }),
    );
  await proxy(TOKEN, fakeEntsoe().fetchImpl, NOW)();
  const first = await readFile(cachePath, 'utf8');
  assert.ok(!first.includes(TOKEN));
  assert.match(JSON.parse(first).tokenPrint, /^[0-9a-f]{16}$/);
  // A new key saved in KOPPLA PÅ, five minutes on: the answer read with the
  // old one is left out, and a key ENTSO-E refuses is said at once.
  const later = NOW + 5 * 60_000;
  const refusing = fakeEntsoe({ refuse: true });
  const wrong = await proxy(NEW_TOKEN, refusing.fetchImpl, later)();
  assert.equal(wrong.status, 502);
  assert.equal(wrong.json().keyRefused, true);
  assert.ok(refusing.calls.length > 0);
  // A good new key is asked at once too, and its answer saved in turn.
  const good = fakeEntsoe();
  const right = await proxy(NEW_TOKEN, good.fetchImpl, later)();
  assert.equal(right.status, 200);
  assert.equal(right.json().fetchedAt, later);
  assert.equal(good.calls.length, 28, 'ENTSO-E is asked');
  assert.ok(
    good.calls.every((query) => query.get('securityToken') === NEW_TOKEN),
  );
  const second = await readFile(cachePath, 'utf8');
  assert.ok(!second.includes(TOKEN) && !second.includes(NEW_TOKEN));
  assert.notEqual(JSON.parse(second).tokenPrint, JSON.parse(first).tokenPrint);
  assert.ok(
    lines.every((line) => !line.includes(TOKEN) && !line.includes(NEW_TOKEN)),
  );
});

test('production kept on disk is served only while it is still allowed', async (t) => {
  quietLogs(t);
  const cachePath = await cacheFile(t);
  const proxy = (env, fetchImpl, at) =>
    harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: TOKEN, ...env },
        fetchImpl,
        now: () => at,
        cachePath,
      }),
    );
  const first = fakeEntsoe();
  await proxy({ ENTSOE_PRODUCTION: 'on' }, first.fetchImpl, NOW)();
  assert.equal(first.calls.length, 36);
  assert.equal((await savedAnswer(cachePath)).points.length, 4);
  // Restarted without ENTSOE_PRODUCTION: the flows come from disk, the
  // production read before does not.
  const later = NOW + 5 * 60_000;
  const off = fakeEntsoe();
  const flowsOnly = proxy({}, off.fetchImpl, later);
  const grid = (await flowsOnly()).json();
  assert.ok(grid.links.length > 0);
  assert.equal(grid.production, null);
  assert.deepEqual((await flowsOnly('/day')).json().points, []);
  assert.ok(
    (await flowsOnly('/week'))
      .json()
      .days.every((day) => day.points.length === 0),
  );
  assert.equal(off.calls.length, 0);
  // Restarted with it still on, the production stands.
  const on = fakeEntsoe();
  const withProduction = proxy(
    { ENTSOE_PRODUCTION: 'on' },
    on.fetchImpl,
    later,
  );
  assert.equal((await withProduction('/day')).json().points.length, 4);
  assert.equal(on.calls.length, 0);
});

test('production allowed since the answer was saved is read at once behind it', async (t) => {
  quietLogs(t);
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  const proxy = (env, fetchImpl, at) =>
    harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: TOKEN, ...env },
        fetchImpl,
        now: () => at,
        cachePath,
      }),
    );
  await proxy({}, fakeEntsoe().fetchImpl, NOW)();
  assert.equal((await savedAnswer(cachePath)).withProduction, false);
  // ENTSOE_PRODUCTION=on and a restart five minutes on: the saved flows are
  // served at once, marked stale, while one refresh reads the production.
  const later = NOW + 5 * 60_000;
  const on = fakeEntsoe();
  const request = proxy({ ENTSOE_PRODUCTION: 'on' }, on.fetchImpl, later);
  const first = (await request()).json();
  assert.ok(first.links.length > 0);
  assert.equal(first.stale, true);
  assert.equal(first.refreshing, true);
  assert.equal(first.fetchedAt, NOW);
  assert.equal(first.productionOffered, true);
  assert.equal(first.production.at, null);
  assert.equal((await nthSave(rename, cachePath, 2)).at, later);
  assert.equal(on.calls.length, 36, 'one refresh, with the production');
  const then = (await request()).json();
  assert.equal(then.stale, undefined);
  assert.ok(Number.isFinite(then.production.at));
  assert.equal(on.calls.length, 36);
});

test('a saved answer that cannot be used is said once and left out', async (t) => {
  const lines = quietLogs(t);
  const leftOut = () =>
    lines.filter((line) => line.includes('saved answer is left out')).length;
  const usable = {
    v: 1,
    at: NOW - 60_000,
    flows: { links: [] },
    points: [],
    withProduction: false,
  };
  for (const [round, text] of [
    '{"at": 17',
    // Another format of the file.
    JSON.stringify({ ...usable, v: 2 }),
    // From a clock an hour ahead: it would never grow old.
    JSON.stringify({ ...usable, at: NOW + 60 * 60_000 }),
  ].entries()) {
    const cachePath = await cacheFile(t);
    await writeFile(cachePath, text);
    const { calls, fetchImpl } = fakeEntsoe();
    const request = harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: TOKEN },
        fetchImpl,
        now: () => NOW,
        cachePath,
      }),
    );
    const answer = await request();
    assert.equal(answer.status, 200);
    assert.equal(answer.json().fetchedAt, NOW);
    assert.equal(calls.length, 28, 'ENTSO-E is asked');
    await request();
    assert.equal(leftOut(), round + 1, 'said once');
    assert.equal((await savedAnswer(cachePath)).at, NOW, 'saved anew');
  }
});

test('an answer that cannot be saved is said once and kept in memory', async (t) => {
  const lines = quietLogs(t);
  const cachePath = await cacheFile(t);
  // Where the file would be, a folder: it can be neither read nor replaced.
  await mkdir(cachePath);
  const { calls, fetchImpl } = fakeEntsoe();
  let clock = NOW;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      now: () => clock,
      cachePath,
    }),
  );
  assert.equal((await request()).status, 200);
  assert.equal((await request()).json().fetchedAt, NOW, 'kept in memory');
  // Three hours on nothing can be served before the refresh, so it is
  // waited for, and its answer cannot be saved either.
  clock += 3 * 60 * 60_000;
  assert.equal((await request()).json().fetchedAt, clock);
  assert.equal(calls.length, 28 + 28);
  assert.equal(
    lines.filter((line) => line.includes('could not be saved')).length,
    1,
  );
  assert.deepEqual(
    await readdir(path.dirname(cachePath)),
    [path.basename(cachePath)],
    'no half-written file is left',
  );
});

test('a refused token is reported, not sent again within the minute', async (t) => {
  const lines = quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe({ refuse: true });
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      now: () => NOW,
      cachePath: await cacheFile(t),
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

test('one border that does not answer is a gap, not the end of the refresh', async (t) => {
  quietLogs(t);
  const ids = async (fetchImpl) => {
    const answer = await harness(
      powerGridEntsoeProxy({
        env: { ENTSOE_SECURITY_TOKEN: TOKEN },
        fetchImpl,
        now: () => NOW,
        cachePath: await cacheFile(t),
      }),
    )();
    assert.equal(answer.status, 200);
    assert.equal(answer.json().stale, undefined);
    return answer.json().links.map((link) => link.id);
  };
  const whole = await ids(fakeEntsoe().fetchImpl);
  assert.ok(whole.includes('DE_SE4'));
  // Germany's side of the cable to SE4 is down: that link is left out, not
  // netted from the other direction alone; every other link stands.
  const live = fakeEntsoe();
  const partial = await ids(async (url) => {
    const query = new URL(url).searchParams;
    return query.get('documentType') === 'A11' &&
      query.get('out_Domain') === ENTSOE_AREAS.DE &&
      query.get('in_Domain') === ENTSOE_AREAS.SE4
      ? new Response('down', { status: 503 })
      : live.fetchImpl(url);
  });
  assert.deepEqual(
    partial,
    whole.filter((id) => id !== 'DE_SE4'),
  );
});

test('production that can no longer be read grows old and goes; the flows stay', async (t) => {
  quietLogs(t);
  const live = fakeEntsoe();
  const cachePath = await cacheFile(t);
  const rename = t.mock.method(fsp, 'rename');
  let productionDown = false;
  let clock = NOW;
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN, ENTSOE_PRODUCTION: 'on' },
      fetchImpl: async (url) => {
        const type = new URL(url).searchParams.get('documentType');
        return productionDown && type !== 'A11'
          ? new Response('down', { status: 503 })
          : live.fetchImpl(url);
      },
      now: () => clock,
      cachePath,
    }),
  );
  const first = (await request()).json();
  assert.ok(Number.isFinite(first.production.at));
  // Generation and load stop answering. A quarter on, once the refresh
  // behind the stale answer is done, the last production still stands
  // beside fresh flows…
  productionDown = true;
  clock += 16 * 60_000;
  assert.equal((await request()).json().stale, true);
  assert.equal((await nthSave(rename, cachePath, 2)).at, clock);
  const soon = await request();
  assert.equal(soon.status, 200);
  assert.equal(soon.json().stale, undefined);
  assert.equal(soon.json().production.at, first.production.at);
  // …and three hours on it is no longer shown as the production now.
  clock += 3 * 60 * 60_000;
  const later = (await request()).json();
  assert.ok(later.links.length > 0);
  assert.equal(later.production.at, null);
});

test('ENTSO-E answers the flows alone unless production is allowed', async (t) => {
  quietLogs(t);
  const { calls, fetchImpl } = fakeEntsoe();
  const request = harness(
    powerGridEntsoeProxy({
      env: { ENTSOE_SECURITY_TOKEN: TOKEN },
      fetchImpl,
      now: () => NOW,
      cachePath: await cacheFile(t),
    }),
  );
  const body = (await request()).json();
  // Generation (A75) and load (A65) are not on ENTSO-E's free-reuse list:
  // never asked for, only the two directions of the fourteen links.
  assert.equal(calls.length, 28);
  assert.ok(calls.every((query) => query.get('documentType') === 'A11'));
  assert.ok(body.links.length > 0);
  assert.equal(body.production, null);
  assert.equal(body.productionOffered, false);
  assert.equal(body.source, 'entsoe');
  const day = (await request('/day')).json();
  assert.deepEqual(day.points, []);
  assert.equal(day.productionOffered, false);
  const week = (await request('/week')).json();
  assert.ok(week.days.every((one) => one.points.length === 0));
  assert.equal(week.productionOffered, false);
});
