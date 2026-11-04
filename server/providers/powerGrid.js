import {
  normalizeFlows,
  normalizeProduction,
} from '../../src/layers/powerGrid/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Svenska kraftnät's control room (no key): the data service behind
// svk.se/om-kraftsystemet/kontrollrummet. map/flow answers the latest
// quarter-hour flow on every Nordic link; production answers the day's
// quarter-hours per type for Sweden. Both change every quarter-hour, so two
// requests at most every five minutes, and only while the layer asks. The
// service refuses requests that do not look like they come from its page.
export const FLOW_URL = (ticks) =>
  `https://www.svk.se/services/controlroom/v2/map/flow?ticks=${ticks}`;
export const PRODUCTION_URL = (date) =>
  `https://www.svk.se/services/controlroom/v2/production?date=${date}&countryCode=SE`;
const TTL_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const QUARTER_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const HEADERS = Object.freeze({
  Accept: 'application/json',
  Referer: 'https://www.svk.se/om-kraftsystemet/kontrollrummet/',
  'User-Agent': 'Mozilla/5.0 (compatible; GodsEyeView-Sweden)',
});

/** "2026-11-04": the Stockholm calendar date of `ms`. */
function stockholmDate(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** Bounded power-grid route for dev and preview. */
export function powerGridProxy({
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
      headers: HEADERS,
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
      const at = now();
      const ticks = Math.floor(at / QUARTER_MS) * QUARTER_MS;
      const [flows, production] = await Promise.all([
        getJson(FLOW_URL(ticks), controller.signal).then(normalizeFlows),
        getJson(PRODUCTION_URL(stockholmDate(at)), controller.signal)
          .then(normalizeProduction)
          // Just after midnight the new day has no quarter-hours yet.
          .then((today) =>
            Number.isFinite(today.total)
              ? today
              : getJson(
                  PRODUCTION_URL(stockholmDate(at - DAY_MS)),
                  controller.signal,
                ).then(normalizeProduction),
          ),
      ]);
      if (!flows.links.length) throw new Error('no flows in the answer');
      return { ...flows, production, fetchedAt: at };
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
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    if (cached && now() - cached.savedAt < TTL_MS)
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'grid', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      return json(200, value);
    } catch (error) {
      console.warn(`[power-grid] refresh failed: ${error?.message || error}`);
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'power_grid_unavailable' });
    }
  }

  return {
    name: 'power-grid',
    configureServer({ middlewares }) {
      middlewares.use('/api/power-grid', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/power-grid', handler);
    },
  };
}
