// Swedish fork: the one CelesTrak transport the GP and SATCAT routes share,
// following CelesTrak's usage policy. Fake clock and fetch; never CelesTrak.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CELESTRAK_ERROR_BUDGET,
  CELESTRAK_REFUSAL_HOLD_MS,
  CELESTRAK_SERVER_HOLD_MS,
  CELESTRAK_URL_GAP_MS,
  celestrakRetryAfterMs,
  createCelestrakUpstream,
  sharedCelestrakUpstream,
} from './celestrakUpstream.js';

const START = Date.parse('2026-11-22T08:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GP = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
const SATCAT = (group) =>
  `https://celestrak.org/satcat/records.php?GROUP=${group}&FORMAT=CSV`;
const TLE = 'ISS\n1 25544U fixture\n2 25544 fixture\n';

/** What celestrak.js asks with: a label for the log, never the URL. */
const asking = (label = 'GP group stations', priority = 0) => ({
  label,
  priority,
  validate: (body) => /^1 /m.test(body),
  invalid: 'no TLE lines in response',
  maxBytes: 1 << 20,
});

/** A transport over a fake clock and fetch; `answer(call)` gives each reply. */
function harness({ answer = () => new Response(TLE), statePath = null } = {}) {
  const clock = { now: START };
  const calls = [];
  const warnings = [];
  const make = () =>
    createCelestrakUpstream({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return answer({ url, init, index: calls.length });
      },
      now: () => clock.now,
      statePath,
      warn: (...args) => warnings.push(args.join(' ')),
    });
  const upstream = make();
  const ask = (url = GP('stations'), options = asking()) =>
    upstream.request(url, options);
  return { upstream, clock, calls, warnings, ask, make };
}

const refusal = (reason) => (error) => {
  assert.equal(error.name, 'CelestrakRefusal');
  if (reason) assert.equal(error.reason, reason);
  return true;
};

/** fetch() as undici rejects it when the name or connection fails. */
const unreachable = (code) => {
  throw new TypeError('fetch failed', {
    cause: Object.assign(new Error(`${code} celestrak.org`), { code }),
  });
};

function tempFile(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-celestrak-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.gev-cache', 'celestrak-policy.json');
}

const status = (code, headers = {}) =>
  new Response(null, { status: code, headers });

/** Each kind of failure, what it answers, and how long every call waits. */
const FAILURES = [
  ['HTTP 500', () => status(500), 15 * MINUTE],
  ['HTTP 503', () => status(503), 15 * MINUTE],
  [
    'HTTP 503 asking 5 min',
    () => status(503, { 'Retry-After': '300' }),
    15 * MINUTE,
  ],
  ['HTTP 503 asking 1 h', () => status(503, { 'Retry-After': '3600' }), HOUR],
  [
    'HTTP 503 asking 10 h',
    () => status(503, { 'Retry-After': String(10 * 3600) }),
    6 * HOUR,
  ],
  [
    'a timeout',
    () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
    15 * MINUTE,
  ],
  [
    'a dropped connection',
    () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      });
    },
    15 * MINUTE,
  ],
  ['an unusable body', () => new Response('<html>busy</html>'), 15 * MINUTE],
  [
    'an oversized body',
    () => new Response('x', { headers: { 'content-length': String(2 << 20) } }),
    15 * MINUTE,
  ],
  ['HTTP 204', () => status(204), 15 * MINUTE],
  ['HTTP 403', () => status(403), 2 * HOUR],
  [
    'HTTP 403 asking 60 s',
    () => status(403, { 'Retry-After': '60' }),
    2 * HOUR,
  ],
  [
    'HTTP 403 asking a date 3 h on',
    () =>
      status(403, { 'Retry-After': new Date(START + 3 * HOUR).toUTCString() }),
    3 * HOUR,
  ],
  [
    'HTTP 403 asking 30 h',
    () => status(403, { 'Retry-After': String(30 * 3600) }),
    24 * HOUR,
  ],
  ['HTTP 429', () => status(429), 2 * HOUR],
  [
    'HTTP 301',
    () => status(301, { Location: 'https://celestrak.org/elsewhere' }),
    2 * HOUR,
  ],
  ['HTTP 400', () => status(400), 2 * HOUR],
];

for (const [kind, answer, pauseMs] of FAILURES)
  test(`${kind} pauses every CelesTrak call, GP and SATCAT, for ${pauseMs / MINUTE} min`, async () => {
    const h = harness({
      answer: ({ index }) => (index === 1 ? answer() : new Response(TLE)),
    });
    await assert.rejects(h.ask(), refusal());
    const until = START + pauseMs;
    assert.equal(h.upstream.status().heldUntil, until);
    for (const url of [GP('visual'), SATCAT('visual'), GP('active')]) {
      assert.equal(h.upstream.admit(url).until, until, url);
      await assert.rejects(
        h.upstream.request(url, asking()),
        refusal('held'),
        url,
      );
    }
    h.clock.now = until - 1;
    await assert.rejects(h.ask(GP('visual')), refusal('held'));
    assert.equal(h.calls.length, 1, 'nothing more was sent');
    assert.equal(h.warnings.length, 1, 'said once');
    assert.match(
      h.warnings[0],
      new RegExp(`paused until ${new Date(until).toISOString()}`),
    );
    h.clock.now = until;
    assert.equal((await h.ask(GP('visual'))).body, TLE);
    assert.equal(h.calls.length, 2);
  });

test('a 403 is logged in the words the usage policy asks for, without the URL', async () => {
  const h = harness({ answer: () => status(403) });
  await assert.rejects(h.ask(), refusal('held'));
  assert.deepEqual(h.warnings, [
    '[celestrak-proxy] CelesTrak refused (403): requests paused until 2026-11-22T10:00:00.000Z; check the usage policy',
  ]);
});

test('every call asks for compressed data, names the app and never follows a redirect', async () => {
  const h = harness();
  await h.ask();
  const [{ url, init }] = h.calls;
  assert.equal(url, GP('stations'));
  assert.match(init.headers['Accept-Encoding'], /\bgzip\b/);
  assert.match(init.headers['User-Agent'], /^gods-eye-view-celestrak-proxy\//);
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
});

test('a redirect counts as an HTTP error, as does an opaque one', async () => {
  for (const answer of [
    () => status(302, { Location: 'https://celestrak.org/moved' }),
    () => ({ status: 0, type: 'opaqueredirect', headers: new Headers() }),
  ]) {
    const h = harness({ answer });
    await assert.rejects(h.ask(), refusal('held'));
    assert.equal(h.upstream.status().errors, 1, 'counted');
    assert.equal(h.upstream.status().heldUntil, START + 2 * HOUR);
    assert.match(h.warnings[0], /redirected the request.*usage policy/);
  }
});

test('a 404 leaves out only its URL: never asked again in this process, and for 24 h after a restart', async (t) => {
  const statePath = tempFile(t);
  const h = harness({
    statePath,
    answer: ({ url }) =>
      url === GP('stations') ? status(404) : new Response(TLE),
  });
  await assert.rejects(h.ask(), refusal('gone'));
  assert.equal(h.upstream.status().heldUntil, null, 'nothing else waits');
  assert.equal((await h.ask(GP('visual'))).body, TLE);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.warnings, [
    '[celestrak-proxy] CelesTrak answered 404 for GP group stations: not asked again, nor for 24 h after a restart',
  ]);
  // Saved as it stood then: a write keeps only what is under 24 h old.
  await h.upstream.flush();
  // In this process, never: not after a day either.
  h.clock.now = START + 30 * HOUR;
  assert.equal(h.upstream.admit(GP('stations')).reason, 'gone');
  await assert.rejects(h.ask(), refusal('gone'));
  assert.equal(h.calls.length, 2, 'not sent again');
  // A new process within 24 h still leaves it out…
  h.clock.now = START + 23 * HOUR;
  const restarted = h.make();
  await assert.rejects(
    restarted.request(GP('stations'), asking()),
    refusal('gone'),
  );
  assert.equal(h.calls.length, 2);
  // …and asks again after them.
  h.clock.now = START + 25 * HOUR;
  const later = h.make();
  await assert.rejects(later.request(GP('stations'), asking()), refusal());
  assert.equal(h.calls.length, 3, 'asked once more');
  await later.flush();
});

test('HTTP errors count over 2 h and the 20th pauses every call for 2 h', async () => {
  const h = harness({
    answer: ({ url }) => (url.includes('down') ? status(503) : status(404)),
  });
  for (let n = 1; n < CELESTRAK_ERROR_BUDGET; n++) {
    await assert.rejects(h.ask(GP(`gone-${n}`)), refusal('gone'));
    h.clock.now += MINUTE;
  }
  assert.equal(h.upstream.status().errors, CELESTRAK_ERROR_BUDGET - 1);
  assert.equal(h.upstream.status().heldUntil, null);
  // A server error pauses, but CelesTrak does not count it.
  await assert.rejects(h.ask(GP('down')), refusal('held'));
  assert.equal(h.upstream.status().errors, CELESTRAK_ERROR_BUDGET - 1);
  h.clock.now += CELESTRAK_SERVER_HOLD_MS;
  const last = h.clock.now;
  await assert.rejects(h.ask(GP('gone-last')), refusal('gone'));
  assert.equal(h.upstream.status().heldUntil, last + CELESTRAK_REFUSAL_HOLD_MS);
  assert.ok(
    h.warnings.includes(
      `[celestrak-proxy] 20 CelesTrak errors in 2 h: requests paused until ${new Date(last + CELESTRAK_REFUSAL_HOLD_MS).toISOString()}; check the usage policy`,
    ),
    h.warnings.join('\n'),
  );
  const sent = h.calls.length;
  await assert.rejects(h.ask(GP('fresh')), refusal('held'));
  assert.equal(h.calls.length, sent);
  // Errors leave the window two hours on, and the count starts again.
  h.clock.now = last + CELESTRAK_REFUSAL_HOLD_MS;
  await assert.rejects(h.ask(GP('gone-again')), refusal('gone'));
  assert.equal(h.upstream.status().errors, 1);
  assert.equal(h.upstream.status().heldUntil, null);
});

test('a 403 that is also the 20th error is still said as a refusal, and the budget beside it', async () => {
  const h = harness({
    answer: ({ url }) => (url.includes('refused') ? status(403) : status(404)),
  });
  for (let n = 1; n < CELESTRAK_ERROR_BUDGET; n++) {
    await assert.rejects(h.ask(GP(`gone-${n}`)), refusal('gone'));
    h.clock.now += MINUTE;
  }
  const at = h.clock.now;
  await assert.rejects(h.ask(GP('refused')), refusal('held'));
  const until = new Date(at + CELESTRAK_REFUSAL_HOLD_MS).toISOString();
  assert.deepEqual(h.warnings.slice(-2), [
    `[celestrak-proxy] CelesTrak refused (403): requests paused until ${until}; check the usage policy`,
    `[celestrak-proxy] 20 CelesTrak errors in 2 h: requests paused until ${until}; check the usage policy`,
  ]);
});

test('waiting() tells a call queued behind another from one in flight', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    answer: async () => {
      await gate;
      return new Response(TLE);
    },
  });
  const first = h.ask(GP('stations'));
  const second = h.ask(GP('visual'));
  assert.equal(h.upstream.waiting(GP('stations')), false, 'in flight');
  assert.equal(h.upstream.waiting(GP('visual')), true, 'queued');
  assert.equal(h.upstream.waiting(GP('geo')), false, 'not asked for');
  release();
  await Promise.all([first, second]);
  assert.equal(h.upstream.waiting(GP('visual')), false);
});

test('calls go one at a time, GP before SATCAT, and the first failure stops the rest of the burst', async () => {
  let inFlight = 0;
  let most = 0;
  const order = [];
  const accept = { ...asking(), validate: () => true };
  const steady = harness({
    answer: async ({ url }) => {
      inFlight++;
      most = Math.max(most, inFlight);
      order.push(url);
      await new Promise(setImmediate);
      inFlight--;
      return new Response(TLE);
    },
  });
  const burst = [
    steady.upstream.request(SATCAT('visual'), { ...accept, priority: 1 }),
    steady.upstream.request(SATCAT('geo'), { ...accept, priority: 1 }),
    steady.upstream.request(GP('visual'), accept),
    steady.upstream.request(GP('geo'), accept),
    // The same URL again shares the call already queued.
    steady.upstream.request(GP('geo'), accept),
  ];
  await Promise.all(burst);
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(order, [
    SATCAT('visual'),
    GP('visual'),
    GP('geo'),
    SATCAT('geo'),
  ]);

  const failing = harness({ answer: () => status(503) });
  const results = await Promise.allSettled(
    ['stations', 'visual', 'gps-ops', 'geo', 'science'].map((group) =>
      failing.ask(GP(group)),
    ),
  );
  assert.equal(failing.calls.length, 1, 'only the first was sent');
  assert.deepEqual(
    results.map(({ status: settled, reason }) => [settled, reason?.reason]),
    [
      ['rejected', 'held'],
      ['rejected', 'held'],
      ['rejected', 'held'],
      ['rejected', 'held'],
      ['rejected', 'held'],
    ],
  );
  assert.equal(failing.warnings.length, 1);
});

test('a URL already queued or in flight is joined, not refused by its own 2 h', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    answer: async () => {
      await gate;
      return new Response(TLE);
    },
  });
  const first = h.ask();
  assert.equal(h.upstream.admit(GP('stations')), null, 'joinable');
  const second = h.ask();
  release();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(
    answers.map(({ body }) => body),
    [TLE, TLE],
  );
  assert.equal(h.calls.length, 1, 'one call for both');
  assert.equal(h.upstream.admit(GP('stations')).reason, 'gap');
});

for (const [kind, answer] of [
  ['a success', () => new Response(TLE)],
  [
    'a timeout',
    () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
  ],
  ['an unusable body', () => new Response('<html>busy</html>')],
])
  test(`after ${kind} the same GP group is not asked again within 2 h, even after a restart`, async (t) => {
    const statePath = tempFile(t);
    const h = harness({
      statePath,
      answer: ({ index }) => (index === 1 ? answer() : new Response(TLE)),
    });
    await h.ask().catch(() => {});
    await h.upstream.flush();
    // A new process an hour on, past any 15-minute pause.
    h.clock.now = START + HOUR;
    const restarted = h.make();
    assert.deepEqual(restarted.admit(GP('stations')), {
      reason: 'gap',
      until: START + CELESTRAK_URL_GAP_MS,
      status: null,
    });
    await assert.rejects(
      restarted.request(GP('stations'), asking()),
      refusal('gap'),
    );
    assert.equal(h.calls.length, 1, 'not sent again');
    // Other groups go on.
    assert.equal((await restarted.request(GP('visual'), asking())).body, TLE);
    h.clock.now = START + CELESTRAK_URL_GAP_MS;
    assert.equal((await restarted.request(GP('stations'), asking())).body, TLE);
    assert.equal(h.calls.length, 3);
    await restarted.flush();
    assert.ok(
      readFileSync(statePath, 'utf8').includes(GP('stations')),
      'the send times are in the file',
    );
  });

test('a call that never connected pauses 15 min but does not start its URL’s 2 h', async () => {
  const h = harness({
    answer: ({ index }) =>
      index === 1 ? unreachable('ENOTFOUND') : new Response(TLE),
  });
  await assert.rejects(h.ask(), refusal('failed'));
  assert.equal(h.upstream.status().heldUntil, START + CELESTRAK_SERVER_HOLD_MS);
  h.clock.now = START + CELESTRAK_SERVER_HOLD_MS;
  assert.equal(h.upstream.admit(GP('stations')), null);
  assert.equal((await h.ask()).body, TLE);
});

test('no log line names a URL, whatever goes wrong', async () => {
  const kinds = [
    ...FAILURES.map(([, answer]) => answer),
    () => unreachable('ENOTFOUND'),
    () => status(404),
  ];
  const h = harness({
    answer: ({ index }) => kinds[index - 1](),
  });
  for (let index = 0; index < kinds.length; index++) {
    await assert.rejects(h.ask(GP(`group-${index}`)), refusal());
    // Past whatever pause it set.
    h.clock.now += 25 * HOUR;
  }
  assert.equal(h.calls.length, kinds.length, 'each kind was met');
  assert.ok(h.warnings.length >= kinds.length);
  for (const line of h.warnings)
    assert.doesNotMatch(
      line,
      /https?:|celestrak\.org|gp\.php|records\.php|GROUP=|FORMAT=/i,
      line,
    );
});

test('the pause, the count, the 404s and the send times outlive a restart in their file', async (t) => {
  const statePath = tempFile(t);
  const h = harness({ statePath, answer: () => status(403) });
  await assert.rejects(h.ask(), refusal('held'));
  await h.upstream.flush();
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(saved.hold, { until: START + 2 * HOUR, status: 403 });
  assert.deepEqual(saved.errors, [START]);
  assert.deepEqual(saved.sent, [[GP('stations'), START]]);
  h.clock.now = START + HOUR;
  const restarted = h.make();
  assert.equal(restarted.status().heldUntil, START + 2 * HOUR);
  assert.equal(restarted.status().errors, 1);
  await assert.rejects(
    restarted.request(GP('visual'), asking()),
    refusal('held'),
  );
  assert.equal(h.calls.length, 1);

  // A pause from a clock far ahead is cut to the longest CelesTrak can ask.
  writeFileSync(
    statePath,
    JSON.stringify({ hold: { until: START + 400 * HOUR, status: 403 } }),
  );
  h.clock.now = START;
  assert.equal(h.make().status().heldUntil, START + 24 * HOUR);
});

test('the shared transport keeps its memory on globalThis across a dev-server restart', async (t) => {
  const statePath = tempFile(t);
  const options = {
    statePath,
    fetchImpl: async () => status(503),
    now: () => START,
    warn: () => {},
  };
  const before = sharedCelestrakUpstream(options);
  await assert.rejects(
    before.request(GP('stations'), asking()),
    refusal('held'),
  );
  await before.flush();
  rmSync(statePath);
  // KOPPLA PÅ re-evaluates the config in-process: a new transport, the same
  // memory, and the file is not read again.
  const after = sharedCelestrakUpstream(options);
  assert.equal(after.status().heldUntil, START + CELESTRAK_SERVER_HOLD_MS);
  const elsewhere = sharedCelestrakUpstream({
    ...options,
    statePath: `${statePath}.other`,
  });
  assert.equal(elsewhere.status().heldUntil, null, 'one memory per file');
});

test('an unreadable or corrupt saved state starts without it, with one warning; a missing one with none', (t) => {
  const statePath = tempFile(t);
  const missing = harness({ statePath });
  assert.equal(missing.upstream.status().heldUntil, null);
  assert.equal(missing.warnings.length, 0, 'no file yet is no warning');

  const corrupt = path.join(path.dirname(path.dirname(statePath)), 'bad.json');
  writeFileSync(corrupt, '{ not json');
  const h = harness({ statePath: corrupt });
  assert.equal(h.upstream.admit(GP('stations')), null);
  h.upstream.status();
  assert.equal(h.warnings.length, 1, 'said once');
  assert.doesNotMatch(h.warnings[0], /bad\.json|https?:/);
});

test('Retry-After reads delay-seconds and future HTTP dates, nothing else', () => {
  assert.equal(celestrakRetryAfterMs('120', START), 120_000);
  assert.equal(
    celestrakRetryAfterMs(new Date(START + HOUR).toUTCString(), START),
    HOUR,
  );
  for (const raw of [
    null,
    '',
    '1.5',
    '-5',
    'soon',
    new Date(START - HOUR).toUTCString(),
  ])
    assert.equal(celestrakRetryAfterMs(raw, START), null, String(raw));
});
