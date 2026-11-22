// Swedish fork: the one adsb.lol transport flights, GNSS and /v2/mil share.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADSBLOL_BUDGET_KEYED,
  ADSBLOL_BUDGET_KEYLESS,
  adsbLolRetryAfterMs,
  createAdsbLolUpstream,
  sharedAdsbLolUpstream,
} from './adsbLolUpstream.js';

const START = Date.parse('2026-11-22T08:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A transport over a fake clock and fetch; `answer(call)` gives each reply. */
function harness({
  env = {},
  answer = () => Response.json({ ac: [] }),
  statePath = null,
} = {}) {
  const clock = { now: START };
  const calls = [];
  const warnings = [];
  const upstream = createAdsbLolUpstream({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return answer({ url, init, index: calls.length });
    },
    now: () => clock.now,
    env,
    statePath,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  const ask = (kind, options = {}) =>
    upstream.request(kind, '/v2/mil', {
      read: (response) => response.json(),
      ...options,
    });
  return { upstream, clock, calls, warnings, ask };
}

const refusal = (reason) => (error) => {
  assert.equal(error.name, 'AdsbLolRefusal');
  assert.equal(error.reason, reason);
  return true;
};

/** fetch() as undici rejects it when the name or connection fails. */
const unreachable = (code) => {
  throw new TypeError('fetch failed', {
    cause: Object.assign(new Error(`${code} api.adsb.lol`), { code }),
  });
};

function tempFile(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-adsblol-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.gev-cache', 'adsblol-budget.json');
}

test('the key goes in x-api-key only when set, trimmed, and never into logs, status or the file', async (t) => {
  const keyless = harness();
  await keyless.ask('flights', { userAgent: 'test/1.0' });
  assert.equal(keyless.calls[0].url, 'https://api.adsb.lol/v2/mil');
  assert.equal('x-api-key' in keyless.calls[0].init.headers, false);
  assert.equal(keyless.calls[0].init.headers['User-Agent'], 'test/1.0');
  assert.equal(keyless.calls[0].init.redirect, 'error');
  assert.ok(keyless.calls[0].init.signal instanceof AbortSignal);
  assert.equal(keyless.upstream.status().keyed, false);

  const SECRET = 'fixture-secret-key-123';
  const statePath = tempFile(t);
  const replies = [
    () => Response.json({ ac: [] }),
    () => new Response('nope', { status: 401 }),
    () => new Response('', { status: 503 }),
    () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
    () => unreachable('ENOTFOUND'),
    () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
  ];
  const keyed = harness({
    env: { ADSBLOL_API_KEY: `  ${SECRET}  ` },
    statePath,
    answer: ({ index }) => replies[index - 1](),
  });
  await keyed.ask('flights');
  assert.equal(keyed.calls[0].init.headers['x-api-key'], SECRET);
  assert.equal(keyed.upstream.status().keyed, true);
  await assert.rejects(keyed.ask('gnss'), refusal('upstream'));
  // Swedish fork: the refused key is left out of the calls that follow.
  await assert.rejects(keyed.ask('mil'), refusal('upstream'));
  assert.equal('x-api-key' in keyed.calls[2].init.headers, false);
  await assert.rejects(keyed.ask('flights'), refusal('timeout'));
  keyed.clock.now += 2 * MINUTE;
  await assert.rejects(keyed.ask('flights'), refusal('failed'));
  keyed.clock.now += 3 * MINUTE;
  await assert.rejects(keyed.ask('flights'), refusal('locked'));
  await keyed.upstream.flush();
  const status = keyed.upstream.status();
  assert.equal(status.keyed, false);
  assert.equal(status.keyRefused, true);
  assert.ok(
    keyed.warnings.some((line) => /check ADSBLOL_API_KEY/.test(line)),
    'a refused key is named, never shown',
  );
  const said = [
    JSON.stringify(status),
    ...keyed.warnings,
    readFileSync(statePath, 'utf8'),
  ];
  for (const text of said) assert.equal(text.includes(SECRET), false, text);

  // A key a header cannot carry is not sent at all, and not shown either.
  const odd = harness({ env: { ADSBLOL_API_KEY: 'two words' } });
  await odd.ask('flights');
  assert.equal('x-api-key' in odd.calls[0].init.headers, false);
  assert.equal(odd.upstream.status().keyed, false);
  assert.equal(odd.warnings.length, 1);
  assert.equal(odd.warnings[0].includes('two words'), false);
});

test('a 429 locks every caller until its Retry-After, with no call sent meanwhile', async () => {
  const h = harness({
    answer: ({ index }) =>
      index === 1
        ? new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '120' },
          })
        : Response.json({ ac: [] }),
  });
  await assert.rejects(h.ask('flights'), (error) => {
    assert.equal(error.reason, 'locked');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 120_000);
    return true;
  });
  h.clock.now += 119_000;
  for (const kind of ['flights', 'gnss', 'mil']) {
    assert.equal(h.upstream.admit(kind).reason, 'locked', kind);
    await assert.rejects(h.ask(kind), refusal('locked'));
  }
  assert.equal(h.calls.length, 1, 'no call while locked');
  assert.equal(h.upstream.status().lockedUntil, START + 120_000);
  h.clock.now += 1_000;
  assert.equal(h.upstream.admit('gnss'), null);
  await h.ask('mil');
  assert.equal(h.calls.length, 2);
});

test('Retry-After is read as seconds or an HTTP date, up to 25 h; 15 min without one', async () => {
  assert.equal(adsbLolRetryAfterMs('30', START), 30_000);
  assert.equal(
    adsbLolRetryAfterMs(new Date(START + 3 * HOUR).toUTCString(), START),
    3 * HOUR,
  );
  assert.equal(
    adsbLolRetryAfterMs(new Date(START - HOUR).toUTCString(), START),
    null,
    'a past date',
  );
  for (const raw of [null, '', 'soon', '1.5', '-3', '1e309'])
    assert.equal(adsbLolRetryAfterMs(raw, START), null, String(raw));

  const lockFor = async (headers) => {
    const h = harness({
      answer: () => new Response('', { status: 429, headers }),
    });
    await assert.rejects(h.ask('gnss'), refusal('locked'));
    return h.upstream.status().lockedUntil - START;
  };
  // The daily window can be most of a day away: no clamp short of 25 h.
  assert.equal(await lockFor({ 'Retry-After': String(22 * 3600) }), 22 * HOUR);
  assert.equal(
    await lockFor({
      'Retry-After': new Date(START + 23 * HOUR).toUTCString(),
    }),
    23 * HOUR,
  );
  assert.equal(await lockFor({ 'Retry-After': '999999' }), 25 * HOUR);
  assert.equal(await lockFor({}), 15 * MINUTE);
  assert.equal(await lockFor({ 'Retry-After': '1' }), 5_000);
});

test('a 403 that speaks of quota locks every caller, read from at most 2 KB of its body; another 403 without a key holds its caller 15 min', async () => {
  for (const padding of [0, 3000]) {
    const body = `Daily quota exceeded for this API key. ${' '.repeat(padding)}`;
    const quota = harness({
      answer: () => new Response(body, { status: 403 }),
    });
    await assert.rejects(quota.ask('gnss'), refusal('locked'));
    assert.equal(quota.upstream.admit('flights').reason, 'locked', padding);
    assert.equal(quota.upstream.status().lockedUntil, START + 15 * MINUTE);
  }
  // The quota words past the first 2 KB are not read.
  const late = harness({
    answer: () => new Response(`${'x'.repeat(3000)} quota`, { status: 403 }),
  });
  await assert.rejects(late.ask('gnss'), refusal('upstream'));

  const other = harness({
    answer: () => new Response('forbidden', { status: 403 }),
  });
  await assert.rejects(other.ask('gnss'), (error) => {
    assert.equal(error.reason, 'upstream');
    assert.equal(error.retryAfterMs, 15 * MINUTE, 'refused without a key: 15 min');
    return true;
  });
  assert.equal(other.upstream.admit('gnss').reason, 'cooldown');
  assert.equal(other.upstream.admit('flights'), null, 'its caller only');
  assert.equal(other.upstream.status().lockedUntil, null);
});

test('a refused key is left out for 15 min: every caller asks without it, counted as such, then the key is tried again', async () => {
  const env = { ADSBLOL_API_KEY: 'typo-key-123' };
  let reply = () => new Response('{"detail":"invalid api key"}', { status: 401 });
  const h = harness({ env, answer: () => reply() });
  await assert.rejects(h.ask('flights'), (error) => {
    assert.equal(error.reason, 'upstream');
    assert.equal(error.status, 401);
    assert.equal(error.retryAfterMs, 0, 'nothing to wait for');
    return true;
  });
  assert.equal(h.upstream.admit('flights'), null, 'no caller is held');
  assert.deepEqual(h.upstream.status(), {
    keyed: false,
    keyRefused: true,
    used: 0,
    limit: ADSBLOL_BUDGET_KEYLESS,
    lockedUntil: null,
    nextResetHint: null,
  });
  reply = () => Response.json({ ac: [] });
  await h.ask('gnss');
  await h.ask('flights');
  assert.equal('x-api-key' in h.calls[1].init.headers, false);
  assert.equal('x-api-key' in h.calls[2].init.headers, false);
  assert.equal(h.upstream.status().used, 2, 'counted as calls without a key');

  // Once the refusal has run out the key is tried again; refused again, it
  // is not warned of twice.
  h.clock.now += 15 * MINUTE;
  assert.equal(h.upstream.status().keyed, true);
  assert.equal(h.upstream.status().used, 1, 'the refused call was keyed');
  reply = () => new Response('', { status: 403 });
  await assert.rejects(h.ask('flights'), refusal('upstream'));
  assert.equal(h.calls[3].init.headers['x-api-key'], 'typo-key-123');
  const refusedWarnings = () =>
    h.warnings.filter((line) => /the key was refused/.test(line)).length;
  assert.equal(refusedWarnings(), 1);
  // A new key is tried at once, and warned of anew.
  env.ADSBLOL_API_KEY = 'second-try-456';
  assert.equal(h.upstream.status().keyRefused, false);
  reply = () => new Response('', { status: 401 });
  await assert.rejects(h.ask('flights'), refusal('upstream'));
  assert.equal(h.calls[4].init.headers['x-api-key'], 'second-try-456');
  assert.equal(refusedWarnings(), 2);
  for (const line of h.warnings)
    assert.equal(/typo-key-123|second-try-456/.test(line), false, line);

  // A key a header cannot carry is warned of once per key too.
  const odd = harness({ env: { ADSBLOL_API_KEY: 'two words' } });
  odd.upstream.status();
  odd.upstream.status();
  assert.equal(odd.warnings.length, 1);
});

test('a call counts, locks and is refused under the key state it went with, whatever is saved before it answers', async () => {
  const env = {};
  let release;
  const h = harness({
    env,
    answer: ({ index }) =>
      index === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Response.json({ ac: [] }),
  });
  const pending = h.ask('flights').catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  // KOPPLA PÅ saves a key while the call without one is out.
  env.ADSBLOL_API_KEY = 'fresh-key-123';
  h.clock.now += 2_000;
  release(
    new Response('quota', {
      status: 429,
      headers: { 'Retry-After': String(16 * 3600) },
    }),
  );
  assert.equal((await pending).reason, 'locked');
  // The address is locked, the new key is not.
  assert.equal(h.upstream.admit('flights'), null);
  assert.deepEqual(h.upstream.status(), {
    keyed: true,
    keyRefused: false,
    used: 0,
    limit: ADSBLOL_BUDGET_KEYED,
    lockedUntil: null,
    nextResetHint: null,
  });
  delete env.ADSBLOL_API_KEY;
  assert.equal(h.upstream.admit('flights').reason, 'locked');
  assert.equal(h.upstream.status().used, 1);

  // A keyed call refused after its key was replaced refuses only that key.
  const swap = { ADSBLOL_API_KEY: 'old-key-111' };
  let answer;
  const s = harness({
    env: swap,
    answer: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  const out = s.ask('flights').catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  swap.ADSBLOL_API_KEY = 'new-key-222';
  answer(new Response('', { status: 401 }));
  assert.equal((await out).status, 401);
  assert.equal(s.upstream.status().keyRefused, false);
  assert.equal(s.upstream.status().keyed, true);
});

test('a new place may be asked at once only while the calls counted keep the pace within twice its even gap', async () => {
  // 450 a day: the flights paced at 324, evenly one every 266.7 s. A burst
  // may spend about half of that at once.
  const burst = harness();
  for (let i = 0; i < 162; i++) await burst.ask('flights');
  assert.equal(burst.upstream.roomForNew('flights'), true);
  await burst.ask('flights');
  assert.equal(burst.upstream.roomForNew('flights'), false);
  assert.equal(burst.upstream.admit('flights'), null, 'the budget is not spent');
  // As the burst nears the end of the window, the pace has room again.
  burst.clock.now += 12 * HOUR;
  assert.equal(burst.upstream.roomForNew('flights'), true);

  // 10 a day: the flights' share 8, paced 7; GNSS's 2 are its own.
  const h = harness({ env: { ADSBLOL_DAILY_BUDGET: '10' } });
  await h.ask('mil');
  for (let i = 0; i < 3; i++) await h.ask('flights');
  await h.ask('gnss');
  assert.equal(h.upstream.roomForNew('flights'), true, 'GNSS does not count');
  await h.ask('flights');
  assert.equal(
    h.upstream.roomForNew('flights'),
    false,
    'the military call counts with the flights',
  );
  h.clock.now = START + DAY + MINUTE;
  assert.equal(h.upstream.roomForNew('flights'), true);
  assert.throws(() => h.upstream.roomForNew('mil'), TypeError);
  // A share too small to pace has no room for a new place at once.
  const tiny = harness({ env: { ADSBLOL_DAILY_BUDGET: '1' } });
  assert.equal(tiny.upstream.roomForNew('flights'), false);
});

test('every failed call holds its caller back, 60 s doubling to 15 min; a call that never reached adsb.lol is not counted', async () => {
  let cancelled = false;
  let reply = () => Response.json({ ac: [] });
  const h = harness({ answer: () => reply() });
  const holdAfter = async (kind, next, reason) => {
    reply = next;
    await assert.rejects(h.ask(kind), refusal(reason));
    return h.upstream.admit(kind).retryAfterMs;
  };
  // A 5xx: its body is dropped unread, and only its caller waits.
  assert.equal(
    await holdAfter(
      'flights',
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
      'upstream',
    ),
    60_000,
  );
  assert.equal(cancelled, true);
  assert.equal(h.upstream.admit('gnss'), null, 'other callers are not held');
  assert.equal(h.upstream.admit('mil'), null);
  // Each failure in a row doubles the wait, up to 15 minutes.
  for (const expected of [120_000, 240_000, 480_000, 900_000, 900_000]) {
    h.clock.now = h.upstream.admit('flights').until;
    assert.equal(
      await holdAfter(
        'flights',
        () => new Response('', { status: 502 }),
        'upstream',
      ),
      expected,
    );
  }
  // A good answer ends the run.
  h.clock.now = h.upstream.admit('flights').until;
  reply = () => Response.json({ ac: [] });
  await h.ask('flights');
  assert.equal(h.upstream.admit('flights'), null);
  // A server error's longer Retry-After wins, up to an hour.
  assert.equal(
    await holdAfter(
      'gnss',
      () =>
        new Response('', { status: 503, headers: { 'Retry-After': '1800' } }),
      'upstream',
    ),
    30 * MINUTE,
  );
  // A 4xx, an unreadable 200 and a timeout hold back too.
  assert.equal(
    await holdAfter('mil', () => new Response('', { status: 404 }), 'upstream'),
    60_000,
  );
  h.clock.now += 61_000;
  assert.equal(
    await holdAfter('mil', () => new Response('not json'), 'failed'),
    120_000,
  );
  h.clock.now += 121_000;
  assert.equal(
    await holdAfter(
      'mil',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      'timeout',
    ),
    240_000,
  );
  // Swedish fork: a lost connection was once thrown as it came and held
  // nothing; now it holds its caller back and, never reaching adsb.lol, is
  // taken back from the count.
  let counted = h.upstream.status().used;
  h.clock.now += 241_000;
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
    reply = () => unreachable(code);
    await assert.rejects(h.ask('mil'), (error) => {
      assert.equal(error.reason, 'failed');
      assert.equal(error.cause.cause.code, code);
      return true;
    });
    assert.equal(h.upstream.status().used, counted, code);
    h.clock.now = h.upstream.admit('mil').until;
  }
  // A failure that may have reached adsb.lol stays counted: a reset, a
  // closed socket or a timeout can come after the request went out.
  for (const code of [
    'ECONNRESET',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
    'ETIMEDOUT',
    null,
  ]) {
    reply = () =>
      code
        ? unreachable(code)
        : (() => {
            throw new TypeError('fetch failed');
          })();
    await assert.rejects(h.ask('mil'), refusal('failed'));
    counted += 1;
    assert.equal(h.upstream.status().used, counted, String(code));
    h.clock.now = h.upstream.admit('mil').until;
  }
});

test('the budget: 450 without a key, 950 with one, or ADSBLOL_DAILY_BUDGET; GNSS has 20 % to itself, /v2/mil stops at 50 %', async () => {
  assert.equal(ADSBLOL_BUDGET_KEYLESS, 450);
  assert.equal(ADSBLOL_BUDGET_KEYED, 950);
  assert.equal(harness().upstream.status().limit, 450);
  assert.equal(
    harness({ env: { ADSBLOL_API_KEY: 'k' } }).upstream.status().limit,
    950,
  );
  const h = harness({ env: { ADSBLOL_DAILY_BUDGET: ' 10 ' } });
  assert.equal(h.upstream.status().limit, 10);
  // GNSS: its own 2 of 10, whatever the others spend.
  await h.ask('gnss');
  h.clock.now += MINUTE;
  await h.ask('gnss');
  await assert.rejects(h.ask('gnss'), (error) => {
    assert.equal(error.reason, 'budget');
    // The oldest of its calls leaves the window a day (and a minute) after.
    assert.equal(error.until, START + DAY + MINUTE);
    return true;
  });
  // /v2/mil: lowest priority, it stops once half the day's budget is used.
  for (let i = 0; i < 3; i++) await h.ask('mil');
  await assert.rejects(h.ask('mil'), refusal('budget'));
  // The flights have the rest, 8, the military calls among them.
  for (let i = 0; i < 5; i++) await h.ask('flights');
  await assert.rejects(h.ask('flights'), refusal('budget'));
  assert.equal(h.upstream.status().used, 10);
  assert.equal(h.calls.length, 10, 'a refused call is never sent');
});

test('calls without a key and with one are counted apart, as adsb.lol counts them', async () => {
  const env = { ADSBLOL_DAILY_BUDGET: '5' };
  const h = harness({ env });
  for (let i = 0; i < 4; i++) await h.ask('flights');
  await assert.rejects(h.ask('flights'), refusal('budget'));
  // A key is metered by itself: its window starts fresh.
  env.ADSBLOL_API_KEY = 'new-free-key';
  assert.equal(h.upstream.status().used, 0);
  await h.ask('flights');
  // Without it again, adsb.lol still counts the address's calls of the day.
  delete env.ADSBLOL_API_KEY;
  assert.equal(h.upstream.status().used, 4);
  assert.equal(h.upstream.admit('flights').reason, 'budget');
});

test('the window rolls: a call is counted for 24 hours, then leaves it', async () => {
  const h = harness({ env: { ADSBLOL_DAILY_BUDGET: '2' } });
  await h.ask('flights');
  h.clock.now += 6 * HOUR;
  await h.ask('flights');
  assert.equal(h.upstream.admit('flights').reason, 'budget');
  assert.equal(h.upstream.status().nextResetHint, START + DAY + MINUTE);
  h.clock.now = START + DAY + MINUTE;
  assert.equal(h.upstream.status().used, 1);
  assert.equal(h.upstream.admit('flights'), null);
});

test('pacing never spends faster than 90 % of the share over the day, and holds back while counted calls would leave too little', async () => {
  // 450 a day: GNSS 90, the flights 360; pacing spends 90 % of each.
  const fresh = harness();
  assert.equal(fresh.upstream.gapMs('flights'), DAY / 324);
  assert.equal(fresh.upstream.gapMs('gnss'), DAY / 81);
  // Swedish fork: the gap once fell to 30 s while yesterday's calls were
  // about to leave the window, and the budget was then gone for hours. Now
  // it never falls below the even spread, whatever leaves the window soon.
  const evening = harness();
  for (let i = 0; i < 14; i++) {
    await evening.ask('flights');
    evening.clock.now += 4.5 * MINUTE;
  }
  evening.clock.now = START + DAY - 5 * MINUTE;
  assert.equal(evening.upstream.gapMs('flights'), DAY / 324);
  // With most of the paced share spent and nothing leaving soon, the gap
  // grows to the most a place waits while its budget lasts.
  const tight = harness({ env: { ADSBLOL_DAILY_BUDGET: '100' } });
  for (let i = 0; i < 60; i++) await tight.ask('flights');
  assert.equal(tight.upstream.gapMs('flights'), 10 * MINUTE);
  // A big budget is paced no faster than every 30 s.
  const loose = harness({ env: { ADSBLOL_DAILY_BUDGET: '100000' } });
  assert.equal(loose.upstream.gapMs('flights'), 30_000);
  assert.equal(loose.upstream.gapMs('gnss'), 60_000);
  assert.throws(() => loose.upstream.gapMs('mil'), TypeError);
});

test('the exact bound: calls counted early in the window slow the pace until they leave it', async () => {
  // 1,000 a day: the flights 800, paced 720, evenly one every 120 s.
  const h = harness({ env: { ADSBLOL_DAILY_BUDGET: '1000' } });
  // 300 calls in a burst at 08:00 leave 420 paced calls until they leave
  // the window a day and a minute later: no more than one per 1/421 of it.
  for (let i = 0; i < 300; i++) await h.ask('flights');
  assert.equal(h.upstream.gapMs('flights'), (DAY + MINUTE) / 421);
  // 400 more, and the 20 left must last most of a day: the most, 10 min.
  for (let i = 0; i < 400; i++) await h.ask('flights');
  h.clock.now += HOUR;
  assert.equal(h.upstream.gapMs('flights'), 10 * MINUTE);
  // Once they have left, the even spread again.
  h.clock.now = START + DAY + MINUTE;
  assert.equal(h.upstream.gapMs('flights'), DAY / 720);
});

test('a lockout belongs to the key state it was earned under', async () => {
  const env = {};
  const h = harness({
    env,
    answer: ({ index }) =>
      index === 1
        ? new Response('', { status: 429 })
        : Response.json({ ac: [] }),
  });
  await assert.rejects(h.ask('flights'), refusal('locked'));
  env.ADSBLOL_API_KEY = 'new-free-key';
  assert.equal(h.upstream.admit('flights'), null, 'a new key is not locked');
  await h.ask('flights');
  delete env.ADSBLOL_API_KEY;
  assert.equal(h.upstream.admit('flights').reason, 'locked');
});

test('counts and lockout persist across a restart, are written only on change, and never hold the key', async (t) => {
  const statePath = tempFile(t);
  const env = { ADSBLOL_API_KEY: 'persist-secret' };
  const first = harness({
    env,
    statePath,
    answer: ({ index }) =>
      index < 3
        ? Response.json({ ac: [] })
        : new Response('', { status: 429, headers: { 'Retry-After': '7200' } }),
  });
  await first.ask('flights');
  await first.ask('gnss');
  await assert.rejects(first.ask('mil'), refusal('locked'));
  await first.upstream.flush();
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(JSON.stringify(saved).includes('persist-secret'), false);
  assert.deepEqual(saved.calls, {
    keyless: [],
    keyed: [[Math.floor(START / MINUTE), 1, 1, 1]],
  });
  assert.deepEqual(saved.lock, {
    until: START + 2 * HOUR,
    status: 429,
    keyed: true,
  });

  // A new process: fresh memory, the same file.
  const second = harness({ env, statePath });
  second.clock.now = START + HOUR;
  assert.equal(second.upstream.status().used, 3);
  assert.equal(second.upstream.status().lockedUntil, START + 2 * HOUR);
  assert.equal(second.upstream.admit('flights').reason, 'locked');

  // Reading, admitting and pacing change nothing, so nothing is written.
  rmSync(statePath);
  second.upstream.status();
  second.upstream.admit('gnss');
  second.upstream.gapMs('flights');
  await second.upstream.flush();
  assert.equal(existsSync(statePath), false);
  second.clock.now = START + 3 * HOUR;
  await second.ask('flights');
  await second.upstream.flush();
  const keyedRows = JSON.parse(readFileSync(statePath, 'utf8')).calls.keyed;
  assert.equal(
    keyedRows.reduce(
      (sum, [, flights, gnss, mil]) => sum + flights + gnss + mil,
      0,
    ),
    4,
  );
});

test('a budget file in the first format is read as calls without a key', (t) => {
  const legacy = path.join(
    path.dirname(path.dirname(tempFile(t))),
    'legacy.json',
  );
  writeFileSync(
    legacy,
    JSON.stringify({ version: 1, calls: [[Math.floor(START / MINUTE), 3]] }),
  );
  const h = harness({ statePath: legacy });
  assert.equal(h.upstream.status().used, 3);
  assert.equal(
    harness({
      statePath: legacy,
      env: { ADSBLOL_API_KEY: 'k' },
    }).upstream.status().used,
    0,
  );
});

test('the shared transport keeps its memory on globalThis across a dev-server restart', async (t) => {
  const statePath = tempFile(t);
  const options = {
    statePath,
    fetchImpl: async () => Response.json({ ac: [] }),
    now: () => START,
    env: {},
    warn: () => {},
  };
  const before = sharedAdsbLolUpstream(options);
  await before.request('flights', '/v2/mil', {
    read: (response) => response.json(),
  });
  await before.flush();
  rmSync(statePath);
  // KOPPLA PÅ re-evaluates the config in-process: a new transport, the same
  // memory, and the file is not read again.
  const after = sharedAdsbLolUpstream(options);
  assert.equal(after.status().used, 1);
  const elsewhere = sharedAdsbLolUpstream({
    ...options,
    statePath: `${statePath}.other`,
  });
  assert.equal(elsewhere.status().used, 0, 'one memory per file');
});

test('an unreadable or corrupt saved budget starts from zero with one warning; a missing one with none', (t) => {
  const statePath = tempFile(t);
  const missing = harness({ statePath });
  assert.equal(missing.upstream.status().used, 0);
  assert.equal(missing.warnings.length, 0, 'no file yet is no warning');

  const corrupt = path.join(path.dirname(path.dirname(statePath)), 'bad.json');
  writeFileSync(corrupt, '{ not json');
  const h = harness({ statePath: corrupt });
  assert.equal(h.upstream.status().used, 0);
  h.upstream.admit('flights');
  assert.equal(h.warnings.length, 1, 'said once');

  // A directory where the file should be cannot be read as one.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-adsblol-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocked = harness({ statePath: dir });
  assert.equal(blocked.upstream.status().used, 0);
  assert.equal(blocked.warnings.length, 1);
});
