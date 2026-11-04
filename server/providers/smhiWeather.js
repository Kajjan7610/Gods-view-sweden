import {
  FORECAST_BOUNDS,
  OBSERVATION_PARAMETERS,
  mergeObservations,
  summarizeForecast,
} from '../../src/layers/smhiWeather/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// SMHI open data (CC BY 4.0, no key). GET / serves the latest hourly
// observations of every station (four small parameter files, cached ten
// minutes); GET /forecast?lat=&lon= serves a summarised snow1g point
// forecast, cached per rounded point for half an hour.
const OBS_URL = (parameter) =>
  `https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/${parameter}/station-set/all/period/latest-hour/data.json`;
export const FORECAST_URL = (lon, lat) =>
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`;
const OBS_TTL_MS = 10 * 60_000;
const FORECAST_TTL_MS = 30 * 60_000;
const FORECAST_CACHE_MAX = 300;
/** Longest a failed refresh keeps serving the last observations, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Bounded SMHI observation and forecast routes for dev and preview. */
export function smhiWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let observations = null;
  const forecasts = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 900 });

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(new Error(`upstream HTTP ${response.status}`), {
          status: response.status,
        });
      }
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadObservations() {
    const entries = Object.entries(OBSERVATION_PARAMETERS);
    const answers = await Promise.allSettled(
      entries.map(([, parameter]) => getJson(OBS_URL(parameter))),
    );
    if (answers[0].status === 'rejected') throw answers[0].reason;
    const byField = {};
    entries.forEach(([field], index) => {
      if (answers[index].status === 'fulfilled')
        byField[field] = answers[index].value;
    });
    const at = now();
    return { stations: mergeObservations(byField, at), fetchedAt: at };
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
    if (url.pathname === '/forecast') {
      const lat = Math.round(Number(url.searchParams.get('lat')) * 1000) / 1000;
      const lon = Math.round(Number(url.searchParams.get('lon')) * 1000) / 1000;
      const { west, south, east, north } = FORECAST_BOUNDS;
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < south ||
        lat > north ||
        lon < west ||
        lon > east
      )
        return json(400, { error: 'outside_forecast_area' });
      const key = `${lon},${lat}`;
      const hit = forecasts.get(key);
      if (hit && now() - hit.savedAt < FORECAST_TTL_MS)
        return json(200, hit.value);
      if (!allow(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      try {
        const { promise } = coalesceProxyRequest(inFlight, key, async () => ({
          ...summarizeForecast(await getJson(FORECAST_URL(lon, lat)), now()),
          fetchedAt: now(),
        }));
        const value = await promise;
        forecasts.delete(key);
        forecasts.set(key, { value, savedAt: now() });
        if (forecasts.size > FORECAST_CACHE_MAX)
          forecasts.delete(forecasts.keys().next().value);
        return json(200, value);
      } catch (error) {
        console.warn(
          `[smhi-weather] forecast failed: ${error?.message || error}`,
        );
        return json(502, { error: 'smhi_forecast_unavailable' });
      }
    }
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    if (observations && now() - observations.savedAt < OBS_TTL_MS)
      return json(200, observations.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'observations',
        loadObservations,
      );
      const value = await promise;
      observations = { value, savedAt: now() };
      console.log(`[smhi-weather] ${value.stations.length} stations`);
      return json(200, value);
    } catch (error) {
      console.warn(`[smhi-weather] refresh failed: ${error?.message || error}`);
      if (observations && now() - observations.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...observations.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'smhi_weather_unavailable' });
    }
  }

  return {
    name: 'smhi-weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/smhi-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/smhi-weather', handler);
    },
  };
}
