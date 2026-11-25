import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';

/** Default live-entry ceiling for the in-memory cache (see CACHE_MAX_ENTRIES). */
export const DEFAULT_MAX_CACHE_ENTRIES = 20_000;

/*
 * Swedish fork: one paced request queue for the page's terrain heights.
 *
 * `/api/terrain/heights` allows a client 90 requests a minute and answers 429
 * with Retry-After 10 past that, before its cache is read. Every layer standing
 * on the ground asks it on its own: the transit floors, rail, the cockpit, the
 * cameras, the Swedish layers' ground heights, one-shot floor reads. In 3D the
 * globe is hidden, so every cell needs the server, and together they reached
 * 147 requests a minute with many 502 and 429 answers.
 *
 * So this service sends one request at a time, starts no two less than
 * REQUEST_GAP_MS apart (60 a minute at most), and fills each with up to 64 of
 * the points its callers wait for, one from each waiting call in turn, so a
 * call for a few points is not held behind another call's hundreds. A point
 * already asked for is shared: a second caller waits for the same answer.
 *
 * A 429 holds the next request for its Retry-After (RATE_LIMIT_WAIT_MS without
 * one). A 5xx that brings no height holds it for SERVER_BACKOFF_FIRST_MS,
 * doubling up to SERVER_BACKOFF_MAX_MS until heights come through; a 502 with
 * some real heights (the route's answer whenever one point has none) holds
 * nothing back. Meanwhile nothing is sent and callers wait. A caller's wait
 * runs out WAIT_TIMEOUT_MS, the request timeout it always had, after it was
 * queued or after the last request that carried one of its points, so with a
 * healthy server every point is answered, however many a caller asks for. Run
 * out, the points still unanswered get the geoid stand-in a failed request
 * gives, and those no other waiting caller holds are not sent: a caller asks
 * again for what it still needs, and a view after a long outage is not queued
 * behind the outage's. While a caller waits, cancelling drops its points
 * nobody else waits for and cancels a request that nobody waits for any more,
 * as its signal cancelled its own request before.
 *
 * The application's surface services own one terrain service per page, so
 * this is the page's pace; a direct data-module caller's default instance
 * (src/data/terrainHeights.js) keeps a queue of its own. Only the timing
 * changed: what each answer, failure and stand-in puts in the cache is as
 * before.
 */
/** Shortest time between the starts of two requests (ms). */
export const REQUEST_GAP_MS = 1000;
/** Wait after a 429 without a Retry-After, as long as the route asks for (ms). */
export const RATE_LIMIT_WAIT_MS = 10_000;
/** First wait after a 5xx answer with no height; each further one doubles it (ms). */
export const SERVER_BACKOFF_FIRST_MS = 2000;
/** Longest wait after a 5xx, and the most a Retry-After may hold the queue (ms). */
export const SERVER_BACKOFF_MAX_MS = 60_000;
/**
 * How long a caller waits, after it was queued or after the last request that
 * carried one of its points, before taking the geoid stand-in (ms).
 */
export const WAIT_TIMEOUT_MS = 30_000;

/**
 * Construct an instance-owned terrainHeights service with explicit dependencies.
 * `maxCacheEntries` overrides the cache bound; it exists so the bound is
 * testable without minting twenty thousand coordinates, mirroring the injectable
 * `maxBytes` on the GBFS reader. Swedish fork: `gapMs`, `clock`, `setTimer` and
 * `clearTimer` set the request pace and its clock, for tests.
 */
export function createTerrainHeights({
  source,
  signal,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  gapMs = REQUEST_GAP_MS,
  clock = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  if (typeof source?.getHeights !== 'function')
    throw new TypeError('Terrain heights require a source');
  signal?.throwIfAborted();
  // src/data/terrainHeights.js — batched, cached client terrain-height resolver
  // (docs/plans/2026-07-05-entity-height-datum-fix.md Task 3).
  //
  // Resolves ELLIPSOIDAL ground height per (lat, lon) via the server-side
  // `/api/terrain/heights` proxy (Task 2 — Re:Earth `heights.json`, disk-cached,
  // serve-stale). When the proxy is unreachable (or errors) AND the point isn't
  // already warm in this module's in-memory cache, falls back to bundled-geoid
  // math (Task 1, `src/data/geoid.js`):
  //
  //   sourceOrthometricM (if finite) + geoidHeight(lat, lon)  → source:'geoid-fallback'
  //   else geoidHeight(lat, lon) alone (H≈0 "at the geoid/coast" prior) → source:'geoid-fallback'
  //
  // Two things learned building the Task 2 proxy (see its report, and the
  // ledger's T2 entry) that this module builds in:
  //
  //   1. The proxy's GET has a Node http header-size ceiling — empirically a
  //      single request much past ~700-1500 points (depending on coordinate
  //      precision) risks a raw socket-level 431 *before* the proxy's own
  //      request handler runs. So every network request this module issues is
  //      chunked at CHUNK_SIZE (64 points), well under that ceiling, and
  //      chunks are sent SEQUENTIALLY (not in parallel) to keep this client
  //      well-behaved against a single dev-server proxy. (Swedish fork: across
  //      every caller of the service, paced; see REQUEST_GAP_MS.)
  //   2. The proxy's disk cache is keyed by the raw `points` query string, with
  //      no eviction — so a client that varies coordinate precision or point
  //      order defeats the warm cache and grows the cache file unbounded. This
  //      module rounds every coordinate to 5 decimal places (~1.1 m of
  //      precision at the equator — comfortably tighter than any of this app's
  //      placement needs) BOTH for its own in-memory cache key AND for the
  //      points string sent to the proxy, so repeated calls (including calls
  //      from a fresh page load, a different camera batch, etc.) consistently
  //      hit the same warm proxy cache entry.

  /** Max points per outgoing request to `/api/terrain/heights` (see file header, point 1). */
  // Match the server's upstream batch so sequential upstream work also fits
  // within this client's 30-second request deadline when Re:Earth slows.
  const CHUNK_SIZE = 64;
  /** That request deadline (ms). */
  const REQUEST_TIMEOUT_MS = 30_000;

  /** Avoid repeatedly hitting a known-failing proxy from warm fallback reads. */
  const GEOID_FALLBACK_COOLDOWN_MS = 60_000;

  /**
   * Live entry ceiling for the cache below. The rounding in point 2 of the file
   * header makes repeated visits to one place share a key; it does nothing to
   * bound the number of DISTINCT places a session visits, and this cache had no
   * eviction, so a long session kept every coordinate it ever resolved for the
   * lifetime of the page.
   *
   * This is a bound, not a budget. At the ~111 m floor grid a city-scale
   * session stays well under it, so eviction is the pathological case rather
   * than the normal one and a well-behaved session sees no extra network. Sized
   * above the sibling caches (adsb.lol points 80, track history 200, TomTom
   * tiles 256) because a miss here costs a proxy round trip, not just RAM.
   */
  const CACHE_MAX_ENTRIES =
    Number.isFinite(maxCacheEntries) && maxCacheEntries > 0
      ? Math.floor(maxCacheEntries)
      : DEFAULT_MAX_CACHE_ENTRIES;

  /**
   * In-memory cache: `"lat.toFixed(5),lon.toFixed(5)"` -> `{ellipsoid, source}`.
   * Module-scoped (not exported) — the only reads are through
   * `cachedEllipsoidalGround` and the internal lookup in
   * `resolveEllipsoidalGround`. Bounded at CACHE_MAX_ENTRIES; write through
   * `cacheStore` and read a consumer-facing hit through `cacheTouch` so the
   * eviction order stays least-recently-used.
   * @type {Map<string, {ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}>}
   */
  const cache = new Map();

  /**
   * Store an entry and drop the coldest ones once past the cap. `Map` iterates
   * in insertion order, so deleting the first key evicts the least recently
   * used provided every write and every consumer read re-inserts its key.
   *
   * Recency rather than plain insertion order because revisits here are
   * spatial: a session comes back to cells near where it already was, so the
   * cell it is parked on must not be evicted merely for having been resolved
   * early.
   * @param {string} key
   * @param {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}} entry
   */
  function cacheStore(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const coldest = cache.keys().next().value;
      if (coldest === undefined) break;
      cache.delete(coldest);
    }
  }

  /**
   * Read an entry and promote it to newest, so a coordinate a consumer keeps
   * asking about survives eviction. Returns undefined on a miss.
   * @param {string} key
   * @returns {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}|undefined}
   */
  function cacheTouch(key) {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  /**
   * Builds the rounded cache key shared between the in-memory cache and the
   * `points` string sent to the proxy (see file header, point 2).
   * @param {number} lat
   * @param {number} lon
   * @returns {string}
   */
  function cacheKey(lat, lon) {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  /**
   * Synchronous read of a previously resolved ellipsoidal ground height.
   * Returns null if this exact (rounded) coordinate hasn't been resolved yet
   * by either the proxy path or the geoid-fallback path.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry ? entry.ellipsoid : null;
  }

  /**
   * Field-test round 5 (2026-07-06, the "sea-level poison"): like
   * cachedEllipsoidalGround but returns null for geoid-FALLBACK entries —
   * only a real Re:Earth value counts. A fallback (cached when the proxy
   * failed mid-burst) is the geoid surface, which at Austin sits ~165 m below
   * the airport: floors built on it sank every sprite/trail, and the mesh
   * sampler's sanity gate rejected REAL surface samples against it. Floor
   * consumers read THIS; the plain read stays for display-only consumers.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedRealEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry && entry.source === 'reearth' ? entry.ellipsoid : null;
  }

  /**
   * Fetches one chunk (<=CHUNK_SIZE points) from the `/api/terrain/heights`
   * proxy. Returns a Map keyed by the same rounded cache key so callers can
   * look results up positionally-independent of upstream response ordering.
   * Throws on any failure (non-ok response, network error, malformed body) —
   * callers decide the fallback behavior per point.
   * @param {Array<{key: string, lat: number, lon: number}>} chunk
   * @returns {Promise<Map<string, number>>} key -> ellipsoid height (m)
   */
  async function fetchChunk(chunk, requestSignal) {
    // lon,lat order (matches the proxy's documented `points=lon,lat;…` contract
    // and Task 2's implementation). Swedish fork: `requestSignal` carries the
    // 30-second request timeout, on the queue's own timers (see `pump`).
    const results = await source.getHeights(chunk, { signal: requestSignal });
    const body = { results };
    if (!Array.isArray(body?.results))
      throw new Error('malformed terrain heights response (no results array)');
    if (body.results.length !== chunk.length) {
      throw new Error(
        `terrain heights response length mismatch (expected ${chunk.length}, got ${body.results.length})`,
      );
    }
    const out = new Map();
    // The proxy is documented to preserve input order (Task 2 report verifies
    // this against the live upstream), so map positionally rather than trust
    // the response's own lon/lat fields to re-match — those are also present
    // for callers who want them, but this module doesn't need them.
    for (let i = 0; i < chunk.length; i += 1) {
      const ellipsoid = body.results[i]?.ellipsoid;
      if (!Number.isFinite(ellipsoid))
        throw new Error(`non-finite ellipsoid height at index ${i}`);
      out.set(chunk[i].key, ellipsoid);
    }
    return out;
  }

  /**
   * Computes the geoid-fallback ellipsoidal height for one point per the
   * brief's fallback chain: `sourceOrthometricM + geoidHeight` when a finite
   * orthometric source height is available, else `geoidHeight` alone (treats
   * the point as if it were at the geoid, i.e. H≈0 — a coast-level prior).
   * Assumes `ensureGeoidReady()` has already resolved.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [sourceOrthometricM]
   * @returns {number}
   */
  function geoidFallback(lat, lon, sourceOrthometricM) {
    const n = geoidHeight(lat, lon);
    return Number.isFinite(sourceOrthometricM) ? sourceOrthometricM + n : n;
  }

  // Swedish fork: the request queue (see REQUEST_GAP_MS at the top).
  /**
   * Points asked for and not answered yet, by cache key. `holds` counts the
   * callers still waiting for the point, `sent`/`sentAt` mark it in a request,
   * and `answer` settles `promise` with the real height, null for none (a
   * stand-in is due), or undefined when a successful answer left it out.
   * @type {Map<string, {key: string, lat: number, lon: number, holds: number,
   *   sent: boolean, sentAt?: number,
   *   answer: (height: number|null|undefined) => void,
   *   promise: Promise<number|null|undefined>}>}
   */
  const waiting = new Map();
  /**
   * The calls with points not sent yet, in the order of their next turn: the
   * points of each in its own order, and where its next turn starts. A
   * request takes one point from each call in turn, so a call asking for a
   * few points rides the next request however many another call has queued.
   * @type {Array<{points: Array<object>, next: number}>}
   */
  let calls = [];
  /** How many waiting points are not in a request yet. */
  let unsentCount = 0;
  /** The request out: its points, abort controller and timeout, or null. */
  let flight = null;
  let lastStartAt = -Infinity;
  let blockedUntil = -Infinity;
  let serverBackoffMs = 0;
  let pumpTimer = null;

  /** Whether a point still waits to be put in a request. */
  const unsent = (point) => !point.sent && waiting.get(point.key) === point;

  /**
   * Whether the route takes the coordinate as sent (5 decimals): finite, and
   * within ±90° and ±180°. It refuses a whole request for one that is not,
   * so such a point is never queued and reads unresolved.
   */
  const routeTakes = (item) =>
    Math.abs(Number(item.lat?.toFixed?.(5))) <= 90 &&
    Math.abs(Number(item.lon?.toFixed?.(5))) <= 180;

  /** The waiting point for a cache key, made when nobody asked for it yet. */
  function want(item) {
    let point = waiting.get(item.key);
    if (!point) {
      point = { key: item.key, lat: item.lat, lon: item.lon, holds: 0 };
      point.sent = false;
      point.promise = new Promise((resolve) => {
        point.answer = resolve;
      });
      waiting.set(item.key, point);
      unsentCount += 1;
    }
    point.holds += 1;
    return point;
  }

  /** Settle a point for everyone waiting for it, unless it was dropped. */
  function settle(point, height) {
    if (waiting.get(point.key) !== point) return;
    waiting.delete(point.key);
    point.answer(height);
  }

  /** The next point a call has to send, or null when it has none left. */
  function nextOf(call) {
    while (call.next < call.points.length && !unsent(call.points[call.next]))
      call.next += 1;
    return call.next < call.points.length ? call.points[call.next] : null;
  }

  /**
   * Up to CHUNK_SIZE points for a request, one from each call in turn; the
   * next request goes on with the call after the last one this one served.
   */
  function take(now) {
    const points = [];
    let served = 0;
    let found = true;
    while (found && !served) {
      found = false;
      for (let i = 0; i < calls.length; i += 1) {
        const call = calls[i];
        const point = nextOf(call);
        if (!point) continue;
        call.next += 1;
        point.sent = true;
        point.sentAt = now;
        unsentCount -= 1;
        points.push(point);
        found = true;
        if (points.length === CHUNK_SIZE) {
          served = i + 1;
          break;
        }
      }
    }
    if (served) calls = [...calls.slice(served), ...calls.slice(0, served)];
    calls = calls.filter((call) => nextOf(call) !== null);
    return points;
  }

  /** Send the next request now, or when the pace and any back-off allow. */
  function pump() {
    if (pumpTimer !== null || flight || unsentCount <= 0 || signal?.aborted)
      return;
    const wait = Math.max(lastStartAt + gapMs, blockedUntil) - clock();
    if (wait > 0) {
      pumpTimer = setTimer(() => {
        pumpTimer = null;
        pump();
      }, wait);
      // A queue waiting for its turn keeps no process alive (a Node test run
      // ends when its tests do).
      pumpTimer?.unref?.();
      return;
    }
    const now = clock();
    const points = take(now);
    if (!points.length) return;
    lastStartAt = now;
    const controller = new AbortController();
    const current = { points, controller, timer: null };
    flight = current;
    // The request timeout it always had; like AbortSignal.timeout, it keeps
    // no process alive.
    current.timer = setTimer(() => {
      current.timer = null;
      controller.abort(
        new DOMException('Terrain heights request timed out', 'TimeoutError'),
      );
    }, REQUEST_TIMEOUT_MS);
    current.timer?.unref?.();
    fetchChunk(
      points.map(({ key, lat, lon }) => ({ key, lat, lon })),
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    ).then(
      (resolved) => land(current, resolved, null),
      (error) => land(current, null, error),
    );
  }

  /**
   * A request came back: cache its real heights (a failure's `partial` too),
   * answer its points, hold the queue after a 429 or a failing server, and go
   * on. The route answers 502 whenever one point has no height (a transient
   * gap, or while it leaves Re:Earth alone after an upstream 429) and still
   * sends the heights it has: such an answer is the server working, not
   * failing, so it holds nothing back beyond the pace.
   */
  function land(current, resolved, error) {
    if (current.timer !== null) clearTimer(current.timer);
    current.timer = null;
    if (flight === current) flight = null;
    if (signal?.aborted) return;
    const partial =
      Array.isArray(error?.partial) &&
      error.partial.length === current.points.length
        ? error.partial
        : [];
    const answered =
      resolved ||
      (error?.status !== 429 &&
        partial.some((item) => Number.isFinite(item?.ellipsoid)));
    if (answered) serverBackoffMs = 0;
    else backOff(error);
    current.points.forEach((point, index) => {
      const ellipsoid = resolved
        ? resolved.get(point.key)
        : partial[index]?.ellipsoid;
      // Round 6 (below): only a FINITE value is cached as 'reearth'.
      if (Number.isFinite(ellipsoid)) {
        cacheStore(point.key, { ellipsoid, source: 'reearth' });
        settle(point, ellipsoid);
      } else settle(point, resolved ? undefined : null);
    });
    pump();
  }

  /** Hold the queue after a rate limit or a failing server. */
  function backOff(error) {
    const status = error?.status;
    const asked = Number.isFinite(error?.retryAfterMs)
      ? error.retryAfterMs
      : null;
    let wait = 0;
    if (status === 429) wait = asked ?? RATE_LIMIT_WAIT_MS;
    else if (status >= 500) {
      serverBackoffMs = Math.min(
        serverBackoffMs * 2 || SERVER_BACKOFF_FIRST_MS,
        SERVER_BACKOFF_MAX_MS,
      );
      wait = Math.max(serverBackoffMs, asked ?? 0);
    }
    if (wait > 0)
      blockedUntil = Math.max(
        blockedUntil,
        clock() + Math.min(wait, SERVER_BACKOFF_MAX_MS),
      );
  }

  /**
   * A caller stopped waiting, cancelled or out of time: its points no other
   * waiting caller holds are not sent (a caller asks again for what it still
   * needs). A cancel also cancels the request out when none of its points is
   * waited for any more.
   */
  function release(points, call, cancelled) {
    calls = calls.filter((other) => other !== call);
    for (const point of points) {
      point.holds -= 1;
      if (point.holds <= 0 && unsent(point)) {
        waiting.delete(point.key);
        unsentCount -= 1;
      }
    }
    if (
      cancelled &&
      flight &&
      flight.points.every((point) => point.holds <= 0)
    ) {
      for (const point of flight.points)
        if (waiting.get(point.key) === point) waiting.delete(point.key);
      flight.controller.abort();
    }
    if (unsentCount <= 0 && pumpTimer !== null) {
      clearTimer(pumpTimer);
      pumpTimer = null;
    }
  }

  /**
   * Wait for the points' answers. The wait runs out WAIT_TIMEOUT_MS after the
   * call was queued or, later, after the last request that carried one of its
   * points; while the queue moves, every waiting call has a point in each
   * request, so a healthy server answers every point. Run out, a point still
   * unanswered reads null (the stand-in is due) and those not sent yet are
   * given up. Rejects when `requestSignal` aborts, giving up the call.
   * @returns {Promise<Array<number|null|undefined>>} In `points` order.
   */
  function waitFor(points, call, requestSignal) {
    return new Promise((resolve, reject) => {
      const queuedAt = clock();
      const heights = points.map(() => null);
      let left = points.length;
      let finished = false;
      let timer = null;
      const finish = (done) => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
        requestSignal?.removeEventListener('abort', abort);
        done();
      };
      const abort = () =>
        finish(() => {
          release(points, call, true);
          reject(requestSignal.reason);
        });
      const watch = () => {
        timer = null;
        let moved = queuedAt;
        for (const point of points)
          if (point.sentAt > moved) moved = point.sentAt;
        const idle = clock() - moved;
        if (idle >= WAIT_TIMEOUT_MS) {
          finish(() => {
            release(points, call, false);
            resolve(heights.slice());
          });
          return;
        }
        timer = setTimer(watch, WAIT_TIMEOUT_MS - idle);
        // Like the request timeout it stands for, it keeps no process alive.
        timer?.unref?.();
      };
      points.forEach((point, index) =>
        point.promise.then((height) => {
          heights[index] = height;
          left -= 1;
          if (left === 0) finish(() => resolve(heights));
        }),
      );
      watch();
      requestSignal?.addEventListener('abort', abort, { once: true });
    });
  }

  /**
   * Resolves ellipsoidal ground height for a batch of coordinates, in order.
   *
   * - Results already warm in the in-memory cache are returned without any
   *   network call.
   * - Remaining (deduplicated) coordinates are sent to `/api/terrain/heights`
   *   in sequential chunks of <=64 points. (Swedish fork: in the page's paced
   *   queue, shared with every other caller; see REQUEST_GAP_MS.)
   * - If a chunk request fails (network error, non-ok HTTP, malformed body),
   *   every point in THAT chunk without a real height in the failure's
   *   `partial` falls back to geoid math
   *   (`sourceOrthometricM + geoidHeight` or `geoidHeight` alone) rather than
   *   failing the whole batch — a transient proxy outage in the middle of a
   *   large batch shouldn't blank out entities whose chunk happened to land
   *   earlier or later.
   * - Every resolved value (proxy or fallback) is written back into the
   *   in-memory cache before this function returns, so a later call — even
   *   with a real proxy round-trip pending — sees a warm hit.
   *
   * @param {Array<{lat:number, lon:number, sourceOrthometricM?:number}>} coords
   * @returns {Promise<Array<{ellipsoid:number, source:'reearth'|'geoid-fallback'}>>}
   *   Same length and order as `coords`.
   */
  async function resolveEllipsoidalGround(
    coords,
    { signal: consumerSignal } = {},
  ) {
    const requestSignal =
      signal && consumerSignal
        ? AbortSignal.any([signal, consumerSignal])
        : consumerSignal || signal;
    requestSignal?.throwIfAborted();
    if (!Array.isArray(coords) || coords.length === 0) return [];

    // Build the per-input work list (key + original index) up front so the
    // final assembly can map back positionally regardless of how many inputs
    // shared a cache key or a chunk.
    const work = coords.map((c, index) => ({
      index,
      lat: c.lat,
      lon: c.lon,
      sourceOrthometricM: c.sourceOrthometricM,
      key: cacheKey(c.lat, c.lon),
    }));

    // Points not yet warm in the cache, deduplicated by key (multiple inputs —
    // even within the same call — naming the same rounded coordinate should
    // only ever hit the network once). Round 5: a geoid-FALLBACK entry does
    // NOT count as permanently warm — it was cached when the proxy failed
    // mid-burst and (at elevated terrain) is a sea-level poison that sank every
    // floor built on it. Give failed keys a short cooldown before re-requesting
    // so warm consumers do not hammer a failing proxy; after it expires, a
    // successful response replaces the fallback entry and clears the path.
    const uncached = [];
    const seenKeys = new Set();
    const now = Date.now();
    // What this call resolved or found warm, so the assembly below can report a
    // point even if a later chunk's writes pushed it past CACHE_MAX_ENTRIES.
    // Without it a batch big enough to evict its own entries would report
    // points as unresolved that it had in fact resolved.
    const resolvedThisCall = new Map();
    for (const item of work) {
      const entry = cacheTouch(item.key);
      const fallbackCooling =
        entry?.source === 'geoid-fallback' &&
        Number.isFinite(entry.retryAt) &&
        now < entry.retryAt;
      if ((entry && entry.source === 'reearth') || fallbackCooling) {
        resolvedThisCall.set(item.key, entry);
        continue;
      }
      // Swedish fork: one coordinate the route refuses would fail the request
      // it shares with others' points; it stays unresolved instead.
      if (!routeTakes(item)) continue;
      if (seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      uncached.push(item);
    }

    // Resolve the network path in <=CHUNK_SIZE requests. Each request's
    // failure is isolated to that request's points (geoid fallback), so a
    // single bad request doesn't lose results for the rest of a large batch.
    // Swedish fork: through the page's paced queue, where a point another
    // caller already asked for is waited for rather than asked again (see
    // REQUEST_GAP_MS at the top). The queue caches what each answer brings.
    const points = uncached.map(want);
    const call = { points: points.filter((point) => !point.sent), next: 0 };
    if (call.points.length) calls.push(call);
    pump();
    const heights = points.length
      ? await waitFor(points, call, requestSignal)
      : [];
    requestSignal?.throwIfAborted();
    const fallback = [];
    uncached.forEach((item, index) => {
      const ellipsoid = heights[index];
      // Round 6: only a FINITE value may be cached as 'reearth'. A point
      // the upstream response omitted used to cache {ellipsoid: undefined,
      // source: 'reearth'} — permanently "warm" yet empty, so its floor
      // read null forever and every later warm skipped it (ATL verify:
      // one contact frozen at the geoid while its neighbors resolved).
      // An omitted point (undefined) now caches nothing and retries on the
      // next warm.
      if (Number.isFinite(ellipsoid))
        resolvedThisCall.set(item.key, { ellipsoid, source: 'reearth' });
      else if (ellipsoid === null) fallback.push(item);
    });
    if (fallback.length) {
      // Proxy down (or cold cache had nothing to serve-stale) — fall back to
      // geoid math for the points of the failed request. A failure that still
      // carries real heights (the proxy's `partial`, e.g. cached points
      // during an upstream 429 pause) keeps them; only the rest use the
      // geoid. `ensureGeoidReady()` is awaited lazily, only on the fallback
      // path, so the common (proxy healthy) case never pays for the geoid
      // grid's dynamic import. Swedish fork: also for the points still
      // unanswered when the wait ran out (see `waitFor`).
      await ensureGeoidReady();
      requestSignal?.throwIfAborted();
      for (const item of fallback) {
        // Swedish fork: a real height that landed meanwhile is kept.
        const landed = cache.get(item.key);
        if (landed?.source === 'reearth') {
          resolvedThisCall.set(item.key, landed);
          continue;
        }
        const ellipsoid = geoidFallback(
          item.lat,
          item.lon,
          item.sourceOrthometricM,
        );
        const entry = {
          ellipsoid,
          source: 'geoid-fallback',
          retryAt: Date.now() + GEOID_FALLBACK_COOLDOWN_MS,
        };
        resolvedThisCall.set(item.key, entry);
        cacheStore(item.key, entry);
      }
    }

    // Assemble the output in the original input order from the cache. A point
    // the upstream omitted has NO entry (round 6 — deliberately uncached so it
    // retries later): report it unresolved instead of throwing.
    return work.map((item) => {
      const entry = cache.get(item.key) || resolvedThisCall.get(item.key);
      return entry
        ? { ellipsoid: entry.ellipsoid, source: entry.source }
        : { ellipsoid: null, source: 'unresolved' };
    });
  }

  signal?.addEventListener(
    'abort',
    () => {
      cache.clear();
      // Swedish fork: nothing is sent once the page's lifetime is over; the
      // callers' waits reject on the same signal.
      if (pumpTimer !== null) clearTimer(pumpTimer);
      pumpTimer = null;
      calls = [];
      unsentCount = 0;
      waiting.clear();
      if (flight) {
        if (flight.timer !== null) clearTimer(flight.timer);
        flight.timer = null;
        flight.controller.abort();
      }
    },
    { once: true },
  );
  return {
    cachedEllipsoidalGround,
    cachedRealEllipsoidalGround,
    resolveEllipsoidalGround,
  };
}
