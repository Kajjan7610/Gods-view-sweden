import { normalizeFireStations } from '../../src/layers/fireStations/records.js';
import { SWEDISH_MUNICIPALITIES } from './polisen/municipalities.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// MCF's INSPIRE download service for fire stations (OGC API Features, no
// key). The dataset is an EU high-value dataset, so it must be reusable under
// CC BY 4.0 or freer; the metadata itself names no licence. Stations move
// rarely, so a day of cache is plenty.
export const MCF_FIRE_STATIONS_URL =
  'https://inspire.mcf.se/brandstationer/ogc/features/v1/collections/US_fireStation/items?f=application%2Fgeo%2Bjson&limit=1000';
const TTL_MS = 24 * 60 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Bounded MCF fire station route for dev and preview. */
export function fireStationsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(MCF_FIRE_STATIONS_URL, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/geo+json' },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      // One page holds them all; a fuller collection would be cut short.
      if (
        Number.isFinite(payload?.numberMatched) &&
        payload.numberMatched > (payload.features?.length ?? 0)
      )
        throw new Error('fire station collection larger than one page');
      return {
        stations: normalizeFireStations(payload, SWEDISH_MUNICIPALITIES),
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
      const { promise } = coalesceProxyRequest(inFlight, 'stations', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(`[fire-stations] ${value.stations.length} stations`);
      return json(200, value);
    } catch (error) {
      console.warn(
        `[fire-stations] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'fire_stations_unavailable' });
    }
  }

  return {
    name: 'fire-stations',
    configureServer({ middlewares }) {
      middlewares.use('/api/fire-stations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fire-stations', handler);
    },
  };
}
