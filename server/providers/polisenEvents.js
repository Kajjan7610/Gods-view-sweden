import {
  createPlaceLookup,
  normalizePoliceEvents,
} from '../../src/layers/policeEvents/records.js';
import { SWEDISH_MUNICIPALITIES } from './polisen/municipalities.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Polismyndigheten's open event notices (free to use, crediting the Police;
// no key): the 500 latest notices in one JSON document.
export const POLISEN_EVENTS_URL = 'https://polisen.se/api/events';
const TTL_MS = 5 * 60_000;
/** How long Polisen is left alone after a failed refresh. */
export const POLISEN_RETRY_AFTER_FAILURE_MS = 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const lookup = createPlaceLookup(SWEDISH_MUNICIPALITIES);

/** Bounded Polisen event route for dev and preview. */
export function polisenEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(POLISEN_EVENTS_URL, {
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
      return { ...normalizePoliceEvents(payload, lookup), fetchedAt: now() };
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
   * One read of Polisen, shared by everyone waiting on it: the new snapshot,
   * or after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[polisen-events] ${value.events.length} notices`);
      return value;
    } catch (error) {
      console.warn(
        `[polisen-events] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + POLISEN_RETRY_AFTER_FAILURE_MS;
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
        : await coalesceProxyRequest(inFlight, 'events', refresh).promise;
    if (!value) return json(502, { error: 'polisen_events_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name: 'polisen-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/polisen-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/polisen-events', handler);
    },
  };
}
