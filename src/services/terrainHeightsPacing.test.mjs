// Swedish fork: the terrain service's paced request queue
// (terrainHeights.js, REQUEST_GAP_MS): one request at a time, at least a
// second apart, up to 64 points each from every waiting caller, a shared
// answer for a point already asked for, and back-off after 429 and 5xx.
// The clock and timers are the test's own, so seconds pass at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerrainHeights,
  REQUEST_GAP_MS,
  RATE_LIMIT_WAIT_MS,
  SERVER_BACKOFF_FIRST_MS,
  SERVER_BACKOFF_MAX_MS,
  WAIT_TIMEOUT_MS,
} from './terrainHeights.js';
import { createApplicationRequestServices } from './requests.js';
import { ensureGeoidReady } from '../data/geoid.js';

// Stand-ins need the geoid grid; load it once so a failed request answers at
// once instead of waiting for the import.
await ensureGeoidReady();

/** Let promise chains and the geoid stand-in run. */
async function settle() {
  for (let i = 0; i < 4; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** A clock and timers the test moves by hand, as the service's options take them. */
function manualTime() {
  let at = 0;
  let next = 1;
  const timers = new Map();
  return {
    clock: () => at,
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { fn, due: at + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    timers,
    /** Move the clock on by `ms`, running every timer whose time comes. */
    async advance(ms) {
      const end = at + ms;
      for (;;) {
        // What is under way now sets its timers at this time, not later.
        await settle();
        let id = null;
        let due = Infinity;
        for (const [key, timer] of timers)
          if (timer.due < due) {
            id = key;
            due = timer.due;
          }
        if (id === null || due > end) break;
        at = Math.max(at, due);
        const { fn } = timers.get(id);
        timers.delete(id);
        fn();
        await settle();
      }
      at = end;
      await settle();
    },
  };
}

/** `count` distinct 5-decimal points on the equator. */
const points = (count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ lat: 0, lon: (from + i) / 1000 }));

/**
 * A `/api/terrain/heights` route through the real request service: `answer`
 * gives each request's response (a height of 100 + lon by default); every
 * request is kept with the time it started.
 */
function route(time, answer = () => null) {
  const requests = [];
  const terrain = createApplicationRequestServices({
    fetchImpl: async (url, { signal }) => {
      const asked = new URL(url, 'http://localhost').searchParams
        .get('points')
        .split(';')
        .map((pair) => pair.split(',').map(Number));
      const request = { at: time.clock(), asked, signal };
      requests.push(request);
      return (
        answer(request, requests.length) ??
        Response.json({
          results: asked.map(([lon]) => ({ ellipsoid: 100 + lon })),
        })
      );
    },
  }).terrain;
  return { requests, terrain };
}

/** The terrain service on the test's clock. */
function service(time, source, options = {}) {
  return createTerrainHeights({
    source,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    ...options,
  });
}

test('a burst of 300 cells goes out in ceil(300/64) requests, at least a second apart', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);

  const pending = heights.resolveEllipsoidalGround(points(300));
  await settle();
  assert.equal(requests.length, 1, 'the first request goes at once');
  await time.advance(10_000);

  assert.equal(requests.length, Math.ceil(300 / 64));
  assert.deepEqual(
    requests.map((request) => request.asked.length),
    [64, 64, 64, 64, 44],
  );
  for (let i = 1; i < requests.length; i += 1)
    assert.ok(
      requests[i].at - requests[i - 1].at >= REQUEST_GAP_MS,
      `request ${i} started ${requests[i].at - requests[i - 1].at} ms after the one before`,
    );
  const out = await pending;
  assert.ok(out.every((result) => result.source === 'reearth'));
  assert.equal(out[299].ellipsoid, 100 + 0.299);
  assert.equal(time.timers.size, 0, 'nothing left running');
});

test('callers asking while a request is out share the next request', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);

  const first = heights.resolveEllipsoidalGround(points(1));
  // Sixty-four callers of one point each, in the same moment.
  const many = Array.from({ length: 64 }, (_, i) =>
    heights.resolveEllipsoidalGround(points(1, 1 + i)),
  );
  await settle();
  assert.equal(requests.length, 1);
  await time.advance(REQUEST_GAP_MS);
  assert.equal(requests.length, 2, 'one more request for all sixty-four');
  assert.equal(requests[1].asked.length, 64);
  await first;
  for (const pending of many)
    assert.equal((await pending)[0].source, 'reearth');
});

test('a few points ride the next request, however many another caller queued', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);

  const large = heights.resolveEllipsoidalGround(points(640));
  await settle();
  const small = heights.resolveEllipsoidalGround(points(2, 5000));
  await time.advance(REQUEST_GAP_MS);
  assert.equal(requests.length, 2);
  const second = requests[1].asked.map(([lon]) => lon);
  assert.ok(second.includes(5) && second.includes(5.001), 'both in request 2');
  assert.equal(second.length, 64, 'the rest of it from the large caller');
  assert.deepEqual(
    (await small).map((result) => result.source),
    ['reearth', 'reearth'],
  );
  await time.advance(20_000);
  assert.equal((await large).length, 640);
});

test('with more calls waiting than a request holds, the next goes on where it stopped', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);
  // The first request goes at once; a hundred calls of two points each wait.
  heights.resolveEllipsoidalGround(points(1, 9999));
  const calls = Array.from({ length: 100 }, (_, i) =>
    heights.resolveEllipsoidalGround(points(2, 2 * i)),
  );
  await time.advance(2 * REQUEST_GAP_MS);
  assert.equal(requests.length, 3);
  // Each call had a point in request 2 or 3: none waits on the others' second.
  const sent = new Set(
    requests
      .slice(1, 3)
      .flatMap((request) =>
        request.asked.map(([lon]) => Math.floor(Math.round(lon * 1000) / 2)),
      ),
  );
  assert.equal(sent.size, 100);
  await time.advance(10_000);
  for (const pending of calls) assert.equal((await pending).length, 2);
});

test('concurrent callers for one point make one request', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);
  const point = { lat: 59.32932, lon: 18.06858 };

  const callers = [1, 2, 3].map(() =>
    heights.resolveEllipsoidalGround([point]),
  );
  // And two more for another point while the first request is out.
  const other = { lat: 59.3, lon: 18.1 };
  const later = [1, 2].map(() => heights.resolveEllipsoidalGround([other]));
  await time.advance(5000);

  assert.equal(requests.length, 2, 'one request per point');
  assert.deepEqual(requests[0].asked, [[18.06858, 59.32932]]);
  assert.deepEqual(requests[1].asked, [[18.1, 59.3]]);
  for (const pending of [...callers, ...later])
    assert.equal((await pending)[0].source, 'reearth');
  assert.equal(
    (await callers[0])[0].ellipsoid,
    (await callers[2])[0].ellipsoid,
  );
});

test('a 429 with Retry-After 10 sends nothing for ten seconds', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time, (request, n) =>
    n === 1
      ? Response.json(
          { error: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '10' } },
        )
      : null,
  );
  const heights = service(time, terrain);

  const limited = await heights.resolveEllipsoidalGround(points(1));
  assert.equal(
    limited[0].source,
    'geoid-fallback',
    'its points take the stand-in',
  );
  const next = heights.resolveEllipsoidalGround(points(1, 1));
  await time.advance(10_000 - 1);
  assert.equal(requests.length, 1, 'nothing for ten seconds');
  await time.advance(1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].at, 10_000);
  assert.equal((await next)[0].source, 'reearth');
});

test('a 429 without Retry-After waits as long as the route asks for', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time, (request, n) =>
    n === 1 ? new Response('busy', { status: 429 }) : null,
  );
  const heights = service(time, terrain);

  await heights.resolveEllipsoidalGround(points(1));
  const next = heights.resolveEllipsoidalGround(points(1, 1));
  await time.advance(RATE_LIMIT_WAIT_MS - 1);
  assert.equal(requests.length, 1);
  await time.advance(1);
  assert.equal(requests.length, 2);
  await next;
});

test('a 502 with no height backs off 2 s, doubling to 60 s, and an answer resets it', async () => {
  const time = manualTime();
  const failures = 6;
  const { requests, terrain } = route(time, (request, n) =>
    n <= failures
      ? Response.json({ error: 'upstream failed' }, { status: 502 })
      : null,
  );
  const heights = service(time, terrain);

  // A reader asking for a new point every second keeps the queue busy.
  for (let s = 0; s < 125; s += 1) {
    heights.resolveEllipsoidalGround(points(1, s));
    await time.advance(1000);
  }
  const starts = requests.slice(0, 8).map((request) => request.at);
  assert.deepEqual(
    starts,
    [0, 2000, 6000, 14_000, 30_000, 62_000, 122_000, 123_000],
  );
  const gaps = starts.slice(1).map((at, i) => at - starts[i]);
  assert.equal(gaps[0], SERVER_BACKOFF_FIRST_MS);
  assert.equal(gaps[5], SERVER_BACKOFF_MAX_MS, 'doubling stops at the cap');
  assert.equal(gaps[6], REQUEST_GAP_MS, 'an answer resets the back-off');
  // Points asked early in the 60 s hold ran out of wait and were given up;
  // the request after it carries only those still waited for.
  const after = requests[6].asked.map(([lon]) => lon);
  assert.ok(after.length > 0);
  assert.ok(
    after.every((lon) => lon >= 0.092),
    'nothing asked before 92 s',
  );
});

test('a 502 that brings real heights holds nothing back beyond the pace', async () => {
  const time = manualTime();
  // The route answers 502 when any point has no height and sends the heights
  // it has (every other point here); once with none at all.
  const { requests, terrain } = route(time, (request, n) => {
    if (n === 6) return Response.json({ error: 'x' }, { status: 502 });
    if (n > 6) return null;
    return Response.json(
      {
        error: 'x',
        partial: request.asked.map(([lon], i) =>
          i % 2 ? null : { ellipsoid: 100 + lon },
        ),
      },
      { status: 502 },
    );
  });
  const heights = service(time, terrain);
  const pending = heights.resolveEllipsoidalGround(points(8 * 64));
  await time.advance(60_000);
  assert.deepEqual(
    requests.map((request) => request.at),
    [0, 1000, 2000, 3000, 4000, 5000, 7000, 8000],
    'the pace only, until a 502 with no height holds the queue 2 s',
  );
  const out = await pending;
  assert.deepEqual(out[0], { ellipsoid: 100, source: 'reearth' });
  assert.equal(out[1].source, 'geoid-fallback');
  assert.equal(out.at(-1).source, 'reearth');
});

test('a caller waits through a back-off shorter than its wait and gets the real height', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time, (request, n) =>
    n === 1
      ? Response.json(
          { error: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '20' } },
        )
      : null,
  );
  const heights = service(time, terrain);
  await heights.resolveEllipsoidalGround(points(1));
  const point = { lat: 62.39, lon: 17.3 };
  const pending = heights.resolveEllipsoidalGround([point]);
  await time.advance(20_000);
  assert.equal(requests.length, 2);
  assert.deepEqual(await pending, [
    { ellipsoid: 100 + point.lon, source: 'reearth' },
  ]);
});

test('a wait runs out 30 s after its last chance; what it left unsent is not asked', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time, (request, n) =>
    n === 1
      ? Response.json(
          { error: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '60' } },
        )
      : null,
  );
  const heights = service(time, terrain);
  await heights.resolveEllipsoidalGround(points(1));
  const point = { lat: 62.39, lon: 17.3 };
  const pending = heights.resolveEllipsoidalGround([point]);
  await time.advance(WAIT_TIMEOUT_MS);
  const [result] = await pending;
  assert.equal(result.source, 'geoid-fallback', 'held 60 s, it waited 30');
  await time.advance(SERVER_BACKOFF_MAX_MS);
  assert.equal(requests.length, 1, 'nobody waits for its point any more');
  assert.equal(time.timers.size, 0, 'nothing left running');
});

test('a large call on a slow but healthy server gets every height', async () => {
  // The camera layer asks for its whole catalogue at once (up to 7,350
  // points); each request here takes 10 s, so the last of 32 starts after
  // more than five minutes.
  const time = manualTime();
  let requests = 0;
  const heights = service(time, {
    getHeights(chunk) {
      requests += 1;
      return new Promise((resolve) =>
        time.setTimer(
          () => resolve(chunk.map(() => ({ ellipsoid: 9 }))),
          10_000,
        ),
      );
    },
  });
  const pending = heights.resolveEllipsoidalGround(points(2000));
  await time.advance(400_000);
  const out = await pending;
  assert.equal(requests, Math.ceil(2000 / 64));
  assert.ok(out.every((result) => result.source === 'reearth'));
});

test('after a 15-minute outage a fresh view is not queued behind the outage', async () => {
  const time = manualTime();
  let down = true;
  const { requests, terrain } = route(time, () =>
    down ? Response.json({ error: 'upstream failed' }, { status: 502 }) : null,
  );
  const heights = service(time, terrain);
  const cells = (count, lat) =>
    Array.from({ length: count }, (_, i) => ({ lat, lon: i / 1000 }));
  // A moving view warms 300 new cells each poll, one warm at a time as the
  // ground floor does, and a reader asks for one point every 10 s. Each is
  // told apart by its latitude, and when it asked is kept.
  const askedAt = new Map();
  let busy = false;
  for (let t = 0; t < 900_000; t += 5000) {
    if (t % 15_000 === 0 && !busy) {
      busy = true;
      const lat = 50 + t / 100_000;
      askedAt.set(lat.toFixed(5), t);
      heights
        .resolveEllipsoidalGround(cells(300, lat))
        .finally(() => (busy = false));
    }
    if (t % 10_000 === 0) {
      const lat = 40 + t / 1_000_000;
      askedAt.set(lat.toFixed(5), t);
      heights.resolveEllipsoidalGround([{ lat, lon: 0 }]);
    }
    await time.advance(5000);
  }
  down = false;
  const recovered = requests.length;
  let done = false;
  const fresh = heights.resolveEllipsoidalGround(cells(300, 61));
  fresh.then(() => (done = true));
  for (let s = 0; s < 120 && !done; s += 1) await time.advance(1000);
  const out = await fresh;
  assert.ok(out.every((result) => result.source === 'reearth'));
  // Nothing whose wait ran out during the outage is sent after it: every
  // point is the fresh view's or asked less than a wait before its request.
  const after = requests.slice(recovered);
  for (const request of after)
    for (const [, lat] of request.asked) {
      if (lat === 61) continue;
      const at = askedAt.get(lat.toFixed(5));
      assert.ok(
        request.at - at < WAIT_TIMEOUT_MS,
        `a point asked at ${at / 1000} s went at ${request.at / 1000} s`,
      );
    }
  // The fresh view shares the requests with the one call still waited for
  // (the moving view's last, asked 17 s before them): ten at most, where the
  // calls the outage left behind used to take three times that.
  assert.ok(
    after.length <= 2 * Math.ceil(300 / 64),
    `the fresh view took ${after.length} requests`,
  );
});

test('a coordinate the route refuses stays unresolved and fails no one else', async () => {
  const time = manualTime();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain);
  const out = await heights.resolveEllipsoidalGround([
    { lat: 59.3, lon: 18.1 },
    { lat: Number.NaN, lon: 18.1 },
    { lat: 59.3, lon: 181 },
    { lat: -91, lon: 0 },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].asked, [[18.1, 59.3]]);
  assert.deepEqual(out, [
    { ellipsoid: 100 + 18.1, source: 'reearth' },
    { ellipsoid: null, source: 'unresolved' },
    { ellipsoid: null, source: 'unresolved' },
    { ellipsoid: null, source: 'unresolved' },
  ]);
});

test('a cancelled caller sends nothing more, and its request out is cancelled', async () => {
  const time = manualTime();
  const held = [];
  const heights = service(time, {
    getHeights(chunk, { signal }) {
      return new Promise((resolve, reject) => {
        held.push({ chunk, signal, resolve });
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    },
  });
  const caller = new AbortController();
  const pending = heights.resolveEllipsoidalGround(points(100), {
    signal: caller.signal,
  });
  assert.equal(held.length, 1);
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(held[0].signal.aborted, true, 'nobody waits for it any more');
  await time.advance(60_000);
  assert.equal(held.length, 1, 'the 36 points left are not sent');
  assert.equal(time.timers.size, 0, 'nothing left running');
});

test('a request another caller still waits for is not cancelled with the first', async () => {
  const time = manualTime();
  const held = [];
  const heights = service(time, {
    getHeights(chunk, { signal }) {
      return new Promise((resolve) => held.push({ chunk, signal, resolve }));
    },
  });
  const caller = new AbortController();
  const first = heights.resolveEllipsoidalGround(points(1), {
    signal: caller.signal,
  });
  const second = heights.resolveEllipsoidalGround(points(1));
  caller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(held[0].signal.aborted, false);
  held[0].resolve([{ ellipsoid: 7 }]);
  assert.deepEqual(await second, [{ ellipsoid: 7, source: 'reearth' }]);
});

test('the page lifetime ending stops the queue and leaves no timer', async () => {
  const time = manualTime();
  const lifetime = new AbortController();
  const { requests, terrain } = route(time);
  const heights = service(time, terrain, { signal: lifetime.signal });
  const pending = heights.resolveEllipsoidalGround(points(200));
  await settle();
  assert.equal(requests.length, 1);
  assert.ok(time.timers.size > 0, 'the next request is due');
  lifetime.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(time.timers.size, 0);
  await time.advance(60_000);
  assert.equal(requests.length, 1);
});

test('a request that never answers frees the queue after its 30 s timeout', async () => {
  const time = manualTime();
  let calls = 0;
  const heights = service(time, {
    getHeights(chunk, { signal }) {
      calls += 1;
      if (calls > 1)
        return Promise.resolve(chunk.map(() => ({ ellipsoid: 5 })));
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
  });
  const stuck = heights.resolveEllipsoidalGround(points(1));
  await time.advance(1000);
  const behind = heights.resolveEllipsoidalGround(points(1, 1));
  await time.advance(28_999);
  assert.equal(calls, 1, 'one request at a time');
  await time.advance(1);
  assert.equal((await stuck)[0].source, 'geoid-fallback');
  assert.equal(calls, 2, 'the next goes when the stuck one times out');
  assert.equal((await behind)[0].source, 'reearth');
});
