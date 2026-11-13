import {
  SMHI_SEA_PARAMETERS,
  mergeSmhiSea,
} from '../../src/layers/seaWeather/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// SMHI's ocean observations (CC BY 4.0, no key): one file per parameter holds
// every station's last day, so a refresh is three requests, at most every ten
// minutes and only while the layer asks. Sjöfartsverket's ViVa, with wind,
// lakes and canals, is not used: Sjöfartsverket does not allow its data to
// be republished (answer to the fork, 2026-11-13).
export const SMHI_SEA_URL = (parameter) =>
  `https://opendata-download-ocobs.smhi.se/api/version/1.0/parameter/${parameter}/station-set/all/period/latest-day/data.json`;
const TTL_MS = 10 * 60_000;
/** How long SMHI is left alone after a refresh failed. */
export const SEA_WEATHER_RETRY_AFTER_FAILURE_MS = 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

/** Bounded SMHI sea weather route for dev and preview. */
export function seaWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
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

  /** SMHI's three files; the level's is the one that must answer. */
  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const entries = Object.entries(SMHI_SEA_PARAMETERS);
      const answers = await Promise.allSettled(
        entries.map(([, parameter]) =>
          getJson(SMHI_SEA_URL(parameter), controller.signal),
        ),
      );
      if (answers[0].status === 'rejected') throw answers[0].reason;
      const byField = {};
      entries.forEach(([field], index) => {
        if (answers[index].status === 'fulfilled')
          byField[field] = answers[index].value;
        else
          console.warn(
            `[sea-weather] SMHI ${field} failed: ${answers[index].reason?.message}`,
          );
      });
      const stations = mergeSmhiSea(byField, now());
      if (!stations.length) throw new Error('no SMHI ocean station answered');
      return { stations, source: 'smhi', fetchedAt: now() };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last snapshot marked stale, or null once it is too old to show. */
  const lastKnown = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  /**
   * One read of SMHI, shared by everyone waiting on it: the new snapshot, or
   * after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[sea-weather] ${value.stations.length} SMHI stations`);
      return value;
    } catch (error) {
      console.warn(`[sea-weather] refresh failed: ${error?.message || error}`);
      retryAfter = now() + SEA_WEATHER_RETRY_AFTER_FAILURE_MS;
      return lastKnown();
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
    const value =
      now() < retryAfter
        ? lastKnown()
        : await coalesceProxyRequest(inFlight, 'stations', refresh).promise;
    if (!value) return json(502, { error: 'sea_weather_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name: 'sea-weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/sea-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sea-weather', handler);
    },
  };
}
