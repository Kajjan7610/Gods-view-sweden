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
// stop list is on hand its alerts are kept and placed as soon as it arrives,
// without asking Trafiklab again. An operator that fails alone keeps its last
// alerts; a refresh where every operator fails leaves Trafiklab alone for a
// quarter of an hour and serves the last answer marked stale.
export const ALERTS_URL = (operator) =>
  `https://opendata.samtrafiken.se/gtfs-rt/${operator}/ServiceAlerts.pb`;
const TTL_MS = 15 * 60_000;
/** After every operator failed, Trafiklab is left alone this long. */
export const TRANSIT_ALERTS_RETRY_AFTER_FAILURE_MS = TTL_MS;
/**
 * Longest a failed refresh keeps serving the last snapshot, marked stale,
 * and longest an operator that fails keeps its last alerts.
 */
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
  let retryAfter = 0;
  /** Each operator's alerts from its last successful read: {alerts, at}. */
  const alertsByOperator = new Map();
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

  /**
   * The answer from the alerts held per operator: placed at their stops, or
   * pending while an operator's stop list is still on its way. Alerts older
   * than STALE_MAX_MS are left out. No request to Trafiklab is made here.
   * @param {number} at When the alerts were read; their periods are judged then.
   * @param {number} failed Operators whose last read failed.
   */
  function place(at, failed) {
    const stops = [];
    const pending = [];
    for (const { operator, name } of operators) {
      const held = alertsByOperator.get(operator);
      if (!held?.alerts.length || now() - held.at > STALE_MAX_MS) continue;
      // Stops are fetched only for an operator with something to place.
      const index = stopsFor(operator);
      if (!index) {
        pending.push(operator);
        continue;
      }
      stops.push(
        ...placeAlerts(held.alerts, index, {
          operator,
          operatorName: name,
          nowSec: Math.floor(at / 1000),
        }),
      );
    }
    return {
      stops: stops.sort((a, b) => a.id.localeCompare(b.id)),
      pending: pending.sort(),
      failed,
      fetchedAt: at,
    };
  }

  async function load(key) {
    const at = now();
    let failed = 0;
    const queue = [...operators];
    async function worker() {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const alerts = await fetchAlerts(next.operator, key);
          alertsByOperator.set(next.operator, { alerts, at });
        } catch (error) {
          // The operator's last alerts stay, for STALE_MAX_MS at most.
          failed += 1;
          console.warn(
            `[transit-alerts] ${next.operator} failed: ${error?.message || error}`,
          );
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failed === operators.length) throw new Error('every operator failed');
    return place(at, failed);
  }

  const describe = (value) =>
    `[transit-alerts] ${value.stops.length} stops with alerts${value.pending.length ? `; waiting for stops of ${value.pending.join(', ')}` : ''}`;

  /** The last answer marked stale, or null once it is too old to show. */
  const lastKnown = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  /**
   * One read of every operator, shared by everyone waiting on it: the new
   * answer, or after a failure the last one (null without one).
   */
  async function refresh(key) {
    try {
      const value = await load(key);
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(describe(value));
      return value;
    } catch (error) {
      console.warn(
        `[transit-alerts] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + TRANSIT_ALERTS_RETRY_AFTER_FAILURE_MS;
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
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const key = String(env.TRAFIKLAB_GTFS_RT_KEY ?? '').trim();
    if (!key) return json(503, { error: 'not_configured' });
    if (cached && now() - cached.savedAt < TTL_MS) {
      // Stop lists that have arrived since: their alerts are placed now,
      // from what was read, without asking Trafiklab again.
      if (cached.value.pending.length) {
        const value = place(cached.value.fetchedAt, cached.value.failed);
        if (value.pending.length < cached.value.pending.length) {
          cached = { ...cached, value };
          console.log(describe(value));
        }
      }
      return json(200, cached.value);
    }
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    const value =
      now() < retryAfter
        ? lastKnown()
        : await coalesceProxyRequest(inFlight, 'alerts', () => refresh(key))
            .promise;
    if (!value) return json(502, { error: 'transit_alerts_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
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
