import { TRANSIT_FEED_REGISTRY } from '../../src/data/transitFeeds.js';
import {
  decodeServiceAlerts,
  placeAlerts,
} from '../../src/layers/transitAlerts/records.js';
import {
  readResponseBytesCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { sharedTrafiklabStatic } from './trafiklabStatic.js';

// Disruptions from the Swedish regional operators' GTFS-RT ServiceAlerts
// (Trafiklab GTFS Regional, CC0), on the same server-side key as the
// vehicle positions (TRAFIKLAB_GTFS_RT_KEY). Every refresh asks each operator
// once, which spends the key's shared monthly quota, so the answer is cached
// a quarter of an hour and asked for only while the layer is on. Alerts are
// placed by the operator's stops from its static GTFS; until an operator's
// stop list is on hand its alerts wait and the cache is kept short.
export const ALERTS_URL = (operator) =>
  `https://opendata.samtrafiken.se/gtfs-rt/${operator}/ServiceAlerts.pb`;
const TTL_MS = 15 * 60_000;
/** Cache life while some operator's stop list is still downloading. */
const PENDING_TTL_MS = 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;

/** The Trafiklab operators: [{operator, name}]. */
export const TRAFIKLAB_ALERT_OPERATORS = Object.freeze(
  TRANSIT_FEED_REGISTRY.filter(
    (feed) =>
      feed.staticOperator && feed.requiresKey === 'TRAFIKLAB_GTFS_RT_KEY',
  ).map((feed) =>
    Object.freeze({ operator: feed.staticOperator, name: feed.name }),
  ),
);

/** Bounded transit-disruption route for dev and preview. */
export function transitAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  operators = TRAFIKLAB_ALERT_OPERATORS,
  stopsFor = (operator) => sharedTrafiklabStatic().stopsFor(operator),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  async function fetchAlerts(operator, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = new URL(ALERTS_URL(operator));
      url.searchParams.set('key', key);
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/x-protobuf' },
      });
      // An operator without an alert feed answers 404: no alerts.
      if (response.status === 404) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        return [];
      }
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        // Never the URL: it carries the key.
        throw new Error(`HTTP ${response.status}`);
      }
      return decodeServiceAlerts(
        await readResponseBytesCapped(response, MAX_BODY_BYTES),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(key) {
    const at = now();
    const stops = [];
    const pending = [];
    let failed = 0;
    const queue = [...operators];
    async function worker() {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const alerts = await fetchAlerts(next.operator, key);
          // Stops are fetched only for an operator with something to place.
          if (!alerts.length) continue;
          const index = stopsFor(next.operator);
          if (!index) {
            pending.push(next.operator);
            continue;
          }
          stops.push(
            ...placeAlerts(alerts, index, {
              operator: next.operator,
              operatorName: next.name,
              nowSec: Math.floor(at / 1000),
            }),
          );
        } catch (error) {
          failed += 1;
          console.warn(
            `[transit-alerts] ${next.operator} failed: ${error?.message || error}`,
          );
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failed === operators.length) throw new Error('every operator failed');
    return {
      stops: stops.sort((a, b) => a.id.localeCompare(b.id)),
      pending: pending.sort(),
      failed,
      fetchedAt: at,
    };
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
    const key = String(env.TRAFIKLAB_GTFS_RT_KEY ?? '').trim();
    if (!key) return json(503, { error: 'not_configured' });
    if (
      cached &&
      now() - cached.savedAt <
        (cached.value.pending.length ? PENDING_TTL_MS : TTL_MS)
    )
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'alerts', () =>
        load(key),
      );
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(
        `[transit-alerts] ${value.stops.length} stops with alerts${value.pending.length ? `; waiting for stops of ${value.pending.join(', ')}` : ''}`,
      );
      return json(200, value);
    } catch (error) {
      console.warn(
        `[transit-alerts] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'transit_alerts_unavailable' });
    }
  }

  return {
    name: 'transit-alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/transit-alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/transit-alerts', handler);
    },
  };
}
