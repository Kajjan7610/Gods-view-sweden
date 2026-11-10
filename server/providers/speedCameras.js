import { sameSiteGated } from './common/same-site.js';
import {
  camerasNear,
  normalizeSpeedCameras,
  unreadCountyNumbers,
} from '../../src/layers/speedCameras/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { TRAFIKVERKET_API_URL, xmlAttr } from './trafikverketProxy.js';

// Trafikverket's fixed traffic safety camera sites (open data, CC0), through
// the existing TRAFIKVERKET_API_KEY. The sites change rarely: the list is
// kept a day. GET / is every site for the map layer; GET /?lat=&lon= is the
// sites within NEAR_KM of a town for the city dossier.

const TTL_MS = 24 * 60 * 60_000;
/** Longest a failed refresh keeps serving the last list, marked stale. */
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
/** A failed refresh leaves Trafikverket alone this long. */
export const SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const NEAR_KM = 15;
const NEAR_MAX = 5;

/** The query for every site still in use. */
export function speedCamerasQuery(key) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="TrafficSafetyCamera" schemaversion="1">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    '<INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>RoadNumber</INCLUDE>' +
    '<INCLUDE>Bearing</INCLUDE><INCLUDE>CountyNo</INCLUDE>' +
    '<INCLUDE>Geometry.WGS84</INCLUDE><INCLUDE>Deleted</INCLUDE>' +
    '</QUERY></REQUEST>'
  );
}

/** Bounded speed camera route for dev and preview. */
export function speedCamerasProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  /** Trafikverket's answer as it came, with when it was read. */
  async function load(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(TRAFIKVERKET_API_URL, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Accept: 'application/json',
        },
        body: speedCamerasQuery(key),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        // The status only: the request body carries the key.
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const fetchedAt = now();
      return {
        payload: await readResponseJsonCapped(response, MAX_BODY_BYTES),
        fetchedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last list while it is young enough to show, marked stale. */
  const lastKnown = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  /** How many sites lack a county, and what Trafikverket gave instead. */
  function countyGaps(cameras, payload) {
    const without = cameras.filter((camera) => !camera.county).length;
    if (!without) return '';
    const given = unreadCountyNumbers(payload)
      .slice(0, 5)
      .map(([number, count]) => `${number}: ${count}`)
      .join(', ');
    return `, ${without} without a county (CountyNo ${given})`;
  }

  /**
   * One read of Trafikverket, shared by everyone waiting on it: the new list,
   * or after a failure the last one (null without one).
   */
  async function refresh(key) {
    try {
      const { payload, fetchedAt } = await load(key);
      const cameras = normalizeSpeedCameras(payload);
      // Sweden has thousands of sites: none at all is a broken answer, and
      // would otherwise empty the map for a day.
      if (!cameras.length) throw new Error('empty speed camera list');
      cached = { value: { cameras, fetchedAt }, savedAt: now() };
      retryAfter = 0;
      console.log(
        `[speed-cameras] ${cameras.length} camera sites${countyGaps(cameras, payload)}`,
      );
      return cached.value;
    } catch (error) {
      console.warn(
        `[speed-cameras] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + SPEED_CAMERAS_RETRY_AFTER_FAILURE_MS;
      return lastKnown();
    }
  }

  /** The list, the last one marked stale, or null when there is none. */
  async function cameras(key) {
    if (cached && now() - cached.savedAt < TTL_MS) return cached.value;
    if (now() < retryAfter) return lastKnown();
    return coalesceProxyRequest(inFlight, 'cameras', () => refresh(key))
      .promise;
  }

  /** A query value as a number; missing and blank are no number. */
  const coordinate = (text) =>
    text == null || text.trim() === '' ? NaN : Number(text);

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
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const key = String(env.TRAFIKVERKET_API_KEY ?? '').trim();
    if (!key) return json(503, { error: 'trafikverket_key_missing' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    // A town is both or neither: one alone is not every site in the country.
    const near =
      url.searchParams.has('lat') || url.searchParams.has('lon')
        ? [
            coordinate(url.searchParams.get('lon')),
            coordinate(url.searchParams.get('lat')),
          ]
        : null;
    if (near && !near.every(Number.isFinite))
      return json(400, { error: 'lat_lon_required' });
    try {
      const value = await cameras(key);
      if (!value) return json(502, { error: 'speed_cameras_unavailable' });
      const headers = value.stale ? { 'X-Data-Stale': 'true' } : {};
      if (!near) return json(200, value, headers);
      const found = camerasNear(value.cameras, near, NEAR_KM);
      return json(
        200,
        {
          radiusKm: NEAR_KM,
          count: found.length,
          nearest: found.slice(0, NEAR_MAX).map((camera) => ({
            ...camera,
            km: Math.round(camera.km * 10) / 10,
          })),
          fetchedAt: value.fetchedAt,
          stale: value.stale === true,
        },
        headers,
      );
    } catch {
      return json(502, { error: 'speed_cameras_unavailable' });
    }
  }

  return {
    name: 'speed-cameras',
    configureServer({ middlewares }) {
      middlewares.use('/api/speed-cameras', sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/speed-cameras', sameSiteGated(handler));
    },
  };
}
