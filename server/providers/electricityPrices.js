import {
  ELECTRICITY_ZONES,
  dayAfter,
  normalizePriceDay,
  priceUrl,
  stockholmDay,
} from '../../src/layers/electricity/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Swedish spot prices per bidding zone from elprisetjustnu.se (free, no key):
// one JSON file per zone and day. Today and tomorrow for SE1–SE4 are eight
// small files; they change once a day, so the cache only has to catch the
// afternoon auction and midnight.
//
// Each file is kept by its date, so a zone whose file fails keeps the prices
// it had while the others renew, and after midnight yesterday's "tomorrow"
// is today's prices even when nothing can be fetched. A refresh that fetched
// nothing leaves elprisetjustnu.se alone for five minutes; meanwhile the
// last prices are served marked stale, for six hours at most.
const TTL_MS = 15 * 60_000;
/** After a failed refresh, and how long an incomplete answer is kept. */
export const ELECTRICITY_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 6 * 60 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Bounded electricity price route for dev and preview. */
export function electricityPricesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** The last successful refresh: {at, savedAt, ttl, day}. */
  let cached = null;
  let retryAfter = 0;
  /** Day files by "<zone>:<date>": the rows last read for that day. */
  const files = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  /** A day file, or [] when it is not published yet (404). */
  async function day(zone, ms, signal) {
    const response = await fetchImpl(priceUrl(zone, ms), {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(`upstream HTTP ${response.status}`);
    }
    return normalizePriceDay(
      await readResponseJsonCapped(response, MAX_BODY_BYTES),
    );
  }

  /**
   * Read the eight day files into `files`. A file that fails keeps what was
   * held for its day; an empty answer never replaces held prices.
   * @returns {Promise<number>} How many files failed.
   */
  async function load(at) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const days = [at, dayAfter(at)];
      const wanted = ELECTRICITY_ZONES.flatMap((zone) =>
        days.map((ms) => ({ zone: zone.id, ms, date: stockholmDay(ms) })),
      );
      const answers = await Promise.allSettled(
        wanted.map(({ zone, ms }) => day(zone, ms, controller.signal)),
      );
      let failed = 0;
      let firstError = null;
      answers.forEach((answer, index) => {
        const { zone, date } = wanted[index];
        const key = `${zone}:${date}`;
        if (answer.status === 'rejected') {
          failed += 1;
          firstError ??= answer.reason;
          console.warn(
            `[electricity-prices] ${zone} ${date} failed: ${answer.reason?.message || answer.reason}`,
          );
        } else if (answer.value.length || !files.get(key)?.length)
          files.set(key, answer.value);
      });
      if (failed === wanted.length)
        throw firstError ?? new Error('every day file failed');
      // Days before today are of no use any more.
      const today = stockholmDay(at);
      for (const key of files.keys())
        if (key.slice(key.indexOf(':') + 1) < today) files.delete(key);
      return failed;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The answer for the Stockholm day `at` falls on, from the files held: null
   * when no zone has prices for that day.
   */
  function assemble(at) {
    const today = stockholmDay(at);
    const tomorrow = stockholmDay(dayAfter(at));
    const zones = ELECTRICITY_ZONES.map((zone) => ({
      ...zone,
      point: [...zone.point],
      today: files.get(`${zone.id}:${today}`) ?? [],
      tomorrow: files.get(`${zone.id}:${tomorrow}`) ?? [],
    }));
    if (zones.every((zone) => !zone.today.length)) return null;
    return { zones, fetchedAt: cached?.at ?? at, day: today };
  }

  /** One shared refresh; a failure keeps what is held and starts the pause. */
  async function refresh() {
    const at = now();
    try {
      const failed = await load(at);
      const value = assemble(at);
      if (!value) throw new Error('no prices for today');
      cached = {
        at,
        savedAt: now(),
        // An answer missing a file is asked for again sooner.
        ttl: failed ? ELECTRICITY_RETRY_AFTER_FAILURE_MS : TTL_MS,
        day: stockholmDay(at),
      };
      retryAfter = 0;
      console.log(
        `[electricity-prices] ${value.zones.map((zone) => `${zone.id} ${zone.today.length}+${zone.tomorrow.length}`).join(', ')}${failed ? `; ${failed} files failed, their last prices kept` : ''}`,
      );
    } catch (error) {
      retryAfter = now() + ELECTRICITY_RETRY_AFTER_FAILURE_MS;
      console.warn(
        `[electricity-prices] refresh failed: ${error?.message || error}`,
      );
    }
  }

  /** Whether the last refresh still stands: inside its life, the same day. */
  const fresh = (at) =>
    Boolean(cached) &&
    at - cached.savedAt < cached.ttl &&
    cached.day === stockholmDay(at);

  async function handler(req, res) {
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    // A new Stockholm day asks again at once.
    const at = now();
    if (!fresh(at) && at >= retryAfter) {
      if (!allow(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      await coalesceProxyRequest(inFlight, 'prices', refresh).promise;
    }
    const end = now();
    const value =
      cached && end - cached.savedAt <= STALE_MAX_MS ? assemble(end) : null;
    if (!value) return json(502, { error: 'electricity_prices_unavailable' });
    if (fresh(end)) return json(200, value);
    return json(200, { ...value, stale: true }, { 'X-Data-Stale': 'true' });
  }

  return {
    name: 'electricity-prices',
    configureServer({ middlewares }) {
      middlewares.use('/api/electricity-prices', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/electricity-prices', handler);
    },
  };
}
