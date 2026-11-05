import { normalizeFlowStations } from '../../src/layers/riverFlow/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// SMHI hydrological observations (CC BY 4.0, no key): discharge every 15
// minutes; one station-set request carries the last hour of every station.
export const SMHI_FLOW_URL =
  'https://opendata-download-hydroobs.smhi.se/api/version/1.0/parameter/2/station-set/all/period/latest-hour/data.json';
const TTL_MS = 15 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 3 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Bounded SMHI river flow route for dev and preview. */
export function riverFlowProxy({
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
      const response = await fetchImpl(SMHI_FLOW_URL, {
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
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      return { stations: normalizeFlowStations(payload), fetchedAt: now() };
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
      console.log(`[river-flow] ${value.stations.length} stations`);
      return json(200, value);
    } catch (error) {
      console.warn(`[river-flow] refresh failed: ${error?.message || error}`);
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'river_flow_unavailable' });
    }
  }

  return {
    name: 'river-flow',
    configureServer({ middlewares }) {
      middlewares.use('/api/river-flow', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/river-flow', handler);
    },
  };
}
