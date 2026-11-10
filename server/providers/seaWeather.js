import {
  SEA_SAMPLE_MAX_AGE_MS,
  normalizeSeaStation,
} from '../../src/layers/seaWeather/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Sjöfartsverket's ViVa (open, no key) answers one station per request, so a
// refresh walks the ~160 stations a few at a time, at most every ten minutes
// and only while the layer asks. The station list itself changes rarely.
export const VIVA_URL =
  'https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/';
const TTL_MS = 10 * 60_000;
/**
 * How long ViVa is left alone after a refresh failed. Longer than elsewhere:
 * one refresh is a request per station.
 */
export const SEA_WEATHER_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const STATIONS_TTL_MS = 24 * 60 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const CONCURRENCY = 6;
const MAX_STATIONS = 400;

/** Bounded ViVa sea weather route for dev and preview. */
export function seaWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let stationList = null;
  let retryAfter = 0;
  /** Every station's last row, for one that does not answer this time. */
  let lastRows = new Map();
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
      if (!stationList || now() - stationList.at > STATIONS_TTL_MS) {
        const body = await getJson(VIVA_URL, controller.signal);
        const list = body?.GetStationsResult?.Stations;
        if (!Array.isArray(list))
          throw new Error('Malformed ViVa station list');
        stationList = { at: now(), list: list.slice(0, MAX_STATIONS) };
      }
      const queue = [...stationList.list];
      const stations = [];
      let failed = 0;
      async function worker() {
        while (queue.length) {
          const station = queue.shift();
          try {
            const body = await getJson(
              `${VIVA_URL}${encodeURIComponent(station.ID)}`,
              controller.signal,
            );
            const row = normalizeSeaStation(
              station,
              body?.GetSingleStationResult?.Samples,
              now(),
            );
            if (row) stations.push(row);
          } catch {
            failed++;
            // Silent this time: its last values stand while they are current.
            const last = lastRows.get(String(station?.ID).slice(0, 12));
            if (last && now() - last.updated <= SEA_SAMPLE_MAX_AGE_MS)
              stations.push(last);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      // Rows carried over from last time do not make a silent ViVa answer.
      if (!stations.length || failed === stationList.list.length)
        throw new Error('no ViVa station answered');
      stations.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      lastRows = new Map(stations.map((row) => [row.id, row]));
      return { stations, failed, fetchedAt: now() };
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
   * One walk of ViVa, shared by everyone waiting on it: the new snapshot, or
   * after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(
        `[sea-weather] ${value.stations.length} stations${value.failed ? `, ${value.failed} did not answer` : ''}`,
      );
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
