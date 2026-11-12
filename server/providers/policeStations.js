import { normalizePoliceStations } from '../../src/layers/policeStations/records.js';
import {
  POLISEN_RETRY_AFTER_FAILURE_MS,
  fetchPolisen,
  polisenGate,
  polisenRetryAfterMs,
} from './polisen/rules.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Polismyndigheten's open station list (no key; free to use with the agency
// credited, like its event notices). Stations change rarely, so a day of
// cache is plenty. Asked for by Polisen's rules for its open data (see
// polisen/rules.js).
export const POLISEN_STATIONS_URL = 'https://polisen.se/api/policestations';
const TTL_MS = 24 * 60 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
/** After a failed refresh Polisen is left alone this long. */
export const POLICE_STATIONS_RETRY_AFTER_FAILURE_MS =
  POLISEN_RETRY_AFTER_FAILURE_MS;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Bounded Polisen police station route for dev and preview. */
export function policeStationsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  gate = polisenGate,
} = {}) {
  let cached = null;
  let retryAfter = 0;
  /** Polisen answered 404: the stations are not asked for again. */
  let gone = false;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchPolisen(
        fetchImpl,
        gate,
        POLISEN_STATIONS_URL,
        { signal: controller.signal },
      );
      const payload = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      const stations = normalizePoliceStations(payload);
      if (!stations.length) throw new Error('empty police station list');
      return { stations, fetchedAt: now() };
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
    const unavailable = () =>
      cached && now() - cached.savedAt <= STALE_MAX_MS
        ? json(
            200,
            { ...cached.value, stale: true },
            { 'X-Data-Stale': 'true' },
          )
        : json(502, { error: 'police_stations_unavailable' });
    if (gone || now() < retryAfter) return unavailable();
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'stations', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[police-stations] ${value.stations.length} stations`);
      return json(200, value);
    } catch (error) {
      console.warn(
        `[police-stations] refresh failed: ${error?.message || error}`,
      );
      if (error?.gone) gone = true;
      retryAfter = now() + polisenRetryAfterMs(error);
      return unavailable();
    }
  }

  return {
    name: 'police-stations',
    configureServer({ middlewares }) {
      middlewares.use('/api/police-stations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/police-stations', handler);
    },
  };
}
