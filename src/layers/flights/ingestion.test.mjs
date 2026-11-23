import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { flightsQuotaRow } from './controls.js';
import { createIngestion } from './ingestion.js';

function setup(
  source,
  { getQuery = () => ({ latitude: 39 }), clearContacts, dropOlderThan } = {},
) {
  const feed = {
    _source: source,
    _activeUpdateControllers: new Set(),
    _trackingRefreshEpoch: 0,
    _lastSource: 'Fixture',
    _lastCoverage: 'local',
    _retryAt: 0,
  };
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    getQuery,
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 2, ids: new Set(['abc123']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
    ...(clearContacts ? { clearContacts } : {}),
    ...(dropOlderThan ? { dropOlderThan } : {}),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

const MINUTE = 60_000;
const STOCKHOLM = { latitude: 59.33, longitude: 18.07 };
/** Stockholm's own disc, and Uppsala's 71 km away. */
const STOCKHOLM_DISC = { latitude: 59.25, longitude: 18.0 };
const UPPSALA = { latitude: 59.86, longitude: 17.64 };
const KIRUNA = { latitude: 67.85, longitude: 20.22 };
/** What the server says with an adsb.lol answer (standalone.js). */
const said = (fields = {}) => ({
  used: 5,
  limit: 450,
  keyed: false,
  keyRefused: false,
  lockedUntil: null,
  cache: 'MISS',
  gapMs: null,
  anchor: STOCKHOLM_DISC,
  asked: STOCKHOLM,
  ...fields,
});
/** A flights refusal as the live source throws it. */
const refusal = (status, fields = {}) =>
  Object.assign(new Error(`Flights HTTP ${status}`), {
    name: 'LiveSourceError',
    status,
    retryAfterMs: 20_000,
    ...fields,
  });

test('civil acquisition rejects late completion after cancellation without publishing records', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.update(null);
  assert.equal(probe.feed._activeUpdateControllers.size, 1);
  for (const controller of probe.feed._activeUpdateControllers)
    controller.abort();
  release({ records: [] });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(probe.accepted.length, 0);
  assert.equal(probe.restores.length, 0);
  assert.equal(probe.feed._activeUpdateControllers.size, 0);
});

test('civil acquisition publishes source time and uses a replaced source on the next request', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.latitude, 39);
      calls += 1;
      return {
        records: [],
        source: 'First',
        observedAtMs: 1234,
        freshness: 'fresh',
        coverage: 'worldwide',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._count, 2);
  assert.deepEqual([...probe.feed._lastTrackingRefreshOutcome.ids], ['abc123']);
  probe.feed._source = {
    async getSnapshot() {
      return {
        records: [],
        source: 'Second',
        observedAtMs: 1250,
        freshness: 'unknown',
      };
    },
  };
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.feed._lastUpdate, 1250);
  assert.equal(probe.feed._backoff, true);
  assert.equal(probe.feed._lastError, 'Source snapshot time unavailable');
  assert.deepEqual(probe.labels, ['First', 'Second']);
  assert.equal(probe.restores.length, 2);
});

// Swedish fork: the flights server tells of adsb.lol's daily quota with each
// answer and with a refusal, which also says how long to wait before asking.
test('civil acquisition keeps the server’s word on its quota and waits as long as it asks', async (t) => {
  const NOW = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => NOW);
  const locked = said({
    used: 450,
    lockedUntil: NOW + 3_600_000,
    cache: null,
    anchor: null,
  });
  let answer = {
    records: [],
    source: 'adsb.lol',
    observedAtMs: NOW - 1000,
    quota: said({ used: 449, cache: 'PACED', gapMs: 267_000 }),
  };
  let calls = 0;
  const probe = setup(
    {
      async getSnapshot() {
        calls += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    { getQuery: () => STOCKHOLM },
  );
  await probe.update(null);
  assert.equal(probe.feed._lastQuota.cache, 'PACED');
  answer = refusal(503, { retryAfterMs: 3_600_000, quota: locked });
  await probe.update(null);
  // The refusal's budget and lock; of the disc still shown, its anchor.
  assert.deepEqual(probe.feed._lastQuota, {
    ...locked,
    anchor: STOCKHOLM_DISC,
    failed: true,
  });
  assert.equal(probe.feed._retryAt, NOW + 3_600_000);
  await probe.update(null);
  assert.equal(calls, 2, 'nothing is asked before the wait is over');
  // A failure without word of the quota keeps the last word on the budget,
  // but a paced disc it no longer is: the row stops saying so.
  probe.feed._retryAt = 0;
  answer = {
    records: [],
    source: 'adsb.lol',
    observedAtMs: NOW - 1000,
    quota: said({ cache: 'PACED', gapMs: 267_000 }),
  };
  await probe.update(null);
  assert.equal(probe.feed._lastQuota.cache, 'PACED');
  assert.equal(probe.feed._lastQuota.failed, undefined);
  probe.feed._retryAt = 0;
  answer = new Error('network');
  await probe.update(null);
  assert.deepEqual(probe.feed._lastQuota, {
    ...said({ cache: null }),
    failed: true,
  });
  // An answer without one clears it.
  probe.feed._retryAt = 0;
  answer = { records: [], source: 'OpenSky Network', observedAtMs: NOW };
  await probe.update(null);
  assert.equal(probe.feed._lastQuota, null);
});

test('after a failed poll the disc still shown keeps where it was read and whether it was older data, judged against that poll’s place', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('sv');
  const NOW = 1_800_000_000_000;
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  let place = STOCKHOLM;
  let answer = {
    records: [],
    source: 'adsb.lol',
    observedAtMs: NOW,
    quota: said({ cache: 'STALE', asked: UPPSALA }),
  };
  const probe = setup(
    {
      async getSnapshot() {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    { getQuery: () => place },
  );
  const rowNow = (cockpit = false) =>
    flightsQuotaRow({
      source: probe.feed._lastSource,
      count: probe.feed._count,
      observedAtMs: probe.feed._lastUpdate,
      quota: probe.feed._lastQuota,
      cockpit,
      now,
    });
  place = UPPSALA;
  await probe.update(null);
  assert.equal(
    rowNow().info,
    'adsb.lol · äldre data från närheten · 2 plan',
    'Stockholm’s disc, served STALE for Uppsala',
  );
  // STALE, then a 502 that says only the budget.
  now += 3 * MINUTE;
  answer = refusal(502, {
    quota: said({ used: 6, cache: null, anchor: null, asked: UPPSALA }),
  });
  await probe.update(null);
  assert.deepEqual(probe.feed._lastQuota, {
    ...said({ used: 6, cache: 'STALE', asked: UPPSALA }),
    failed: true,
  });
  const outage = rowNow();
  assert.equal(
    outage.info,
    'adsb.lol svarar inte · äldre data · 2 plan · för 3 min sedan',
  );
  assert.match(outage.infoTitle, /Läst runt en plats 71 km bort\./);

  // A jump far away, then a 502: judged against where this poll asked.
  probe.feed._retryAt = 0;
  now += MINUTE;
  place = KIRUNA;
  answer = refusal(502, {
    quota: said({ used: 7, cache: null, anchor: null, asked: KIRUNA }),
  });
  await probe.update(null);
  assert.deepEqual(probe.feed._lastQuota.asked, KIRUNA);
  assert.deepEqual(probe.feed._lastQuota.anchor, STOCKHOLM_DISC);
  // In Cockpit, the pose's place, the same way.
  for (const cockpit of [false, true]) {
    const far = rowNow(cockpit);
    assert.equal(
      far.info,
      'adsb.lol svarar inte · äldre data · 2 plan · för 4 min sedan',
    );
    assert.match(far.infoTitle, /Läst runt en plats 964 km bort\./);
  }
  // No answer at all: still this poll's place, and the last word on the budget.
  probe.feed._retryAt = 0;
  place = STOCKHOLM;
  answer = new Error('network');
  await probe.update(null);
  assert.deepEqual(probe.feed._lastQuota.asked, STOCKHOLM);
  assert.equal(probe.feed._lastQuota.used, 7);
  assert.equal(rowNow().infoTitle.includes('km bort'), false);
});

test('aircraft read from an adsb.lol disc leave the map once older than 30 minutes; OpenSky’s frames stay as they were', async (t) => {
  const NOW = 1_800_000_000_000;
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const cleared = [];
  let answer;
  const run = () => {
    now = NOW;
    cleared.length = 0;
    return setup(
      {
        async getSnapshot() {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      { getQuery: () => STOCKHOLM, clearContacts: () => cleared.push(now) },
    );
  };
  const disc = (observedAtMs) => ({
    records: [],
    source: 'adsb.lol',
    observedAtMs,
    quota: said(),
  });

  // Failed polls: kept for 30 minutes, then gone.
  let probe = run();
  answer = disc(NOW);
  await probe.update(null);
  answer = refusal(502, { quota: said({ anchor: null, cache: null }) });
  now = NOW + 30 * MINUTE;
  await probe.update(null);
  assert.equal(cleared.length, 0);
  assert.equal(probe.feed._count, 2);
  probe.feed._retryAt = 0;
  now = NOW + 30 * MINUTE + 1;
  await probe.update(null);
  assert.equal(cleared.length, 1);
  assert.equal(probe.feed._count, 0);
  assert.equal(probe.feed._lastUpdate, null);
  assert.equal(probe.feed._lastQuota.anchor, null, 'no disc is shown');
  probe.feed._retryAt = 0;
  now += MINUTE;
  await probe.update(null);
  assert.equal(cleared.length, 1, 'once');

  // Waiting out a refusal, the aircraft still age.
  probe = run();
  answer = disc(NOW);
  await probe.update(null);
  answer = refusal(503, {
    retryAfterMs: 16 * 60 * MINUTE,
    quota: said({ lockedUntil: NOW + 16 * 60 * MINUTE, anchor: null }),
  });
  await probe.update(null);
  now = NOW + 31 * MINUTE;
  await probe.update(null);
  assert.equal(probe.feed._backoff, true, 'not asked: still waiting');
  assert.equal(cleared.length, 1);
  assert.equal(probe.feed._count, 0);

  // An answer that old is not drawn.
  probe = run();
  answer = disc(NOW - 31 * MINUTE);
  await probe.update(null);
  assert.equal(probe.accepted.length, 0);
  assert.equal(cleared.length, 1);
  assert.equal(probe.feed._count, 0);
  assert.equal(probe.feed._lastUpdate, null);

  // OpenSky mode's own frames name no adsb.lol disc: they stay.
  probe = run();
  answer = { records: [], source: 'OpenSky Network', observedAtMs: NOW };
  await probe.update(null);
  answer = new Error('network');
  now = NOW + 45 * MINUTE;
  await probe.update(null);
  assert.equal(cleared.length, 0);
  assert.equal(probe.feed._count, 2);
});

// Swedish fork: a whole view's discs are read at different times; its
// aircraft leave the map each on its own once older than 30 min.
test('a whole view’s aircraft go each on its own once past 30 minutes: after an answer, a failed poll and while waiting', async (t) => {
  const NOW = 1_800_000_000_000;
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const cutoffs = [];
  let left = 2;
  let answer;
  const probe = setup(
    {
      async getSnapshot() {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    {
      getQuery: () => STOCKHOLM,
      dropOlderThan: (cutoff) => {
        cutoffs.push(cutoff);
        return left;
      },
    },
  );
  const whole = (fields = {}) => ({
    records: [],
    source: 'adsb.lol',
    observedAtMs: now,
    quota: said({ discs: { shown: 3, total: 6 }, ...fields }),
  });
  answer = whole();
  left = 1;
  await probe.update(null);
  assert.deepEqual(cutoffs, [NOW - 30 * MINUTE]);
  assert.equal(probe.feed._count, 1, 'what is left of the contacts');
  // A failed poll, and the wait it asks for.
  now += MINUTE;
  answer = refusal(502, { retryAfterMs: 5 * MINUTE });
  await probe.update(null);
  now += MINUTE;
  await probe.update(null);
  assert.deepEqual(cutoffs.slice(1), [
    NOW + MINUTE - 30 * MINUTE,
    NOW + 2 * MINUTE - 30 * MINUTE,
  ]);
  // One disc is one age: nothing to drop on its own.
  probe.feed._retryAt = 0;
  answer = { ...whole(), quota: said() };
  await probe.update(null);
  assert.equal(cutoffs.length, 3);
});
