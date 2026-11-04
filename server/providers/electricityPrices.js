import {
  ELECTRICITY_ZONES,
  normalizePriceDay,
  priceUrl,
} from '../../src/layers/electricity/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Swedish spot prices per bidding zone from elprisetjustnu.se (free, no key):
// one JSON file per zone and day. Today and tomorrow for SE1–SE4 are eight
// small files; they change once a day, so the cache only has to catch the
// afternoon auction and midnight.
const TTL_MS = 15 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 6 * 60 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60_000;

/** Bounded electricity price route for dev and preview. */
export function electricityPricesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
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

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const at = now();
      const zones = await Promise.all(
        ELECTRICITY_ZONES.map(async (zone) => {
          const [today, tomorrow] = await Promise.all([
            day(zone.id, at, controller.signal),
            day(zone.id, at + DAY_MS, controller.signal),
          ]);
          return { ...zone, point: [...zone.point], today, tomorrow };
        }),
      );
      if (zones.every((zone) => !zone.today.length))
        throw new Error('no prices for today');
      return { zones, fetchedAt: at, day: priceUrl('SE3', at) };
    } finally {
      clearTimeout(timer);
    }
  }

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
    // A new Stockholm day invalidates the cache at once.
    if (
      cached &&
      now() - cached.savedAt < TTL_MS &&
      cached.value.day === priceUrl('SE3', now())
    )
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'prices', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(
        `[electricity-prices] ${value.zones.map((zone) => `${zone.id} ${zone.today.length}+${zone.tomorrow.length}`).join(', ')}`,
      );
      return json(200, value);
    } catch (error) {
      console.warn(
        `[electricity-prices] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'electricity_prices_unavailable' });
    }
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
