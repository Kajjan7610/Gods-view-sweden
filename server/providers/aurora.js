import { latestKp, normalizeOvation } from '../../src/layers/aurora/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// NOAA SWPC (public domain, no key): the OVATION aurora grid, refreshed every
// few minutes, and the planetary K index. The grid is ~0.9 MB of JSON for the
// whole globe; the proxy keeps the northern band as compact rows.
export const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
export const KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const TTL_MS = 10 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Bounded aurora forecast route for dev and preview. */
export function auroraProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function getJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(`upstream HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, MAX_BODY_BYTES);
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const [grid, kp] = await Promise.allSettled([
        getJson(OVATION_URL, controller.signal),
        getJson(KP_URL, controller.signal),
      ]);
      if (grid.status === 'rejected') throw grid.reason;
      return {
        ...normalizeOvation(grid.value),
        kp: kp.status === 'fulfilled' ? latestKp(kp.value) : null,
        fetchedAt: now(),
      };
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
    if (cached && now() - cached.savedAt < TTL_MS)
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'aurora', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(
        `[aurora] OVATION ${new Date(value.forecast ?? value.fetchedAt).toISOString()}, Kp ${value.kp?.kp ?? '?'}`,
      );
      return json(200, value);
    } catch (error) {
      console.warn(`[aurora] refresh failed: ${error?.message || error}`);
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'aurora_unavailable' });
    }
  }

  return {
    name: 'aurora',
    configureServer({ middlewares }) {
      middlewares.use('/api/aurora', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aurora', handler);
    },
  };
}
