import {
  camerasNear,
  normalizeSpeedCameras,
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
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

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
        cameras: normalizeSpeedCameras(
          await readResponseJsonCapped(response, MAX_BODY_BYTES),
        ),
        fetchedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function cameras(key) {
    if (cached && now() - cached.savedAt < TTL_MS) return cached.value;
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'cameras', () =>
        load(key),
      );
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(`[speed-cameras] ${value.cameras.length} camera sites`);
      return value;
    } catch (error) {
      console.warn(
        `[speed-cameras] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return { ...cached.value, stale: true };
      throw error;
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
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const key = String(env.TRAFIKVERKET_API_KEY ?? '').trim();
    if (!key) return json(503, { error: 'trafikverket_key_missing' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const value = await cameras(key);
      if (!url.searchParams.has('lat')) return json(200, value);
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return json(400, { error: 'lat_lon_required' });
      const near = camerasNear(value.cameras, [lon, lat], NEAR_KM);
      return json(200, {
        radiusKm: NEAR_KM,
        count: near.length,
        nearest: near.slice(0, NEAR_MAX).map((camera) => ({
          ...camera,
          km: Math.round(camera.km * 10) / 10,
        })),
        fetchedAt: value.fetchedAt,
        stale: value.stale === true,
      });
    } catch {
      return json(502, { error: 'speed_cameras_unavailable' });
    }
  }

  return {
    name: 'speed-cameras',
    configureServer({ middlewares }) {
      middlewares.use('/api/speed-cameras', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/speed-cameras', handler);
    },
  };
}
