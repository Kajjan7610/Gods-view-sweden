import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { auroraOutlook } from '../../src/auroraModel.js';

// Tonight's northern lights outlook (Swedish fork): NOAA Space Weather
// Prediction Center's three-day planetary Kp forecast (US Government work,
// no key) and SMHI's hourly cloud cover for the place (snow1g, CC BY 4.0,
// no key), combined by src/auroraModel.js. Kp is read every half hour, the
// clouds per 0.1° cell every half hour.

export const KP_FORECAST_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
export const SMHI_POINT_URL = (lon, lat) =>
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`;
const TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CLOUD_CACHE_MAX = 300;
/** SMHI's forecast covers Scandinavia: Sweden and its neighbours. */
const SWEDEN = { west: 10, south: 55, east: 25, north: 69.5 };

/** NOAA's rows as `{ time, kp, observed, scale }`, oldest first. */
export function normalizeKp(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      // Older answers are arrays with a header row; newer ones objects.
      const [timeTag, kp, observed, scale] = Array.isArray(row)
        ? row
        : [row?.time_tag, row?.kp, row?.observed, row?.noaa_scale];
      const time = Date.parse(`${String(timeTag ?? '').replace(' ', 'T')}Z`);
      // A slot without a value is unknown, never a calm Kp 0.
      const value = kp == null || String(kp).trim() === '' ? NaN : Number(kp);
      if (!Number.isFinite(time) || !Number.isFinite(value)) return null;
      return {
        time,
        kp: value,
        observed: observed === 'observed',
        scale: /^G\d$/.test(String(scale ?? '')) ? scale : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

/** SMHI's hourly cloud cover as `{ time, octas }`. */
export function normalizeClouds(payload) {
  return (Array.isArray(payload?.timeSeries) ? payload.timeSeries : [])
    .map((step) => ({
      time: Date.parse(String(step?.time ?? step?.validTime ?? '')),
      // A step without cloud cover is an unknown sky, never a clear one.
      octas:
        step?.data?.cloud_area_fraction == null
          ? NaN
          : Number(step.data.cloud_area_fraction),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.time) &&
        Number.isFinite(row.octas) &&
        row.octas >= 0 &&
        row.octas <= 8,
    );
}

/** Bounded aurora outlook route for dev and preview (beside the original's
    OVATION map layer, server/providers/aurora.js). */
export function auroraOutlookProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let kp = null;
  const clouds = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readKp() {
    if (kp && now() - kp.at < TTL_MS) return kp.value;
    try {
      kp = { value: normalizeKp(await getJson(KP_FORECAST_URL)), at: now() };
    } catch (error) {
      if (!kp) throw error;
      console.warn(`[aurora] kp: ${error?.message}`);
    }
    return kp.value;
  }

  async function readClouds(lat, lon) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = clouds.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    try {
      const value = normalizeClouds(
        await getJson(SMHI_POINT_URL(lon.toFixed(2), lat.toFixed(2))),
      );
      clouds.set(key, { value, at: now() });
      if (clouds.size > CLOUD_CACHE_MAX)
        clouds.delete(clouds.keys().next().value);
      return value;
    } catch (error) {
      // Without clouds the outlook still says what the sky could show.
      console.warn(`[aurora] clouds: ${error?.message}`);
      return hit?.value ?? [];
    }
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < SWEDEN.south ||
      lat > SWEDEN.north ||
      lon < SWEDEN.west ||
      lon > SWEDEN.east
    )
      return json(400, { error: 'point_outside_sweden' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const [series, cover] = await Promise.all([
        readKp(),
        readClouds(lat, lon),
      ]);
      const at = now();
      return json(200, {
        ...auroraOutlook({ kp: series, clouds: cover, lat, lon, now: at }),
        // The latest observed Kp, for "right now".
        kpNow: series.filter((row) => row.observed).at(-1)?.kp ?? null,
        fetchedAt: at,
      });
    } catch {
      return json(502, { error: 'upstream_failed' });
    }
  }

  return {
    name: 'aurora-outlook',
    configureServer({ middlewares }) {
      middlewares.use('/api/aurora-outlook', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aurora-outlook', handler);
    },
  };
}
