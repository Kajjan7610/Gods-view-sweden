import { normalizeSrMessages } from '../../src/layers/srTraffic/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Sveriges Radio's traffic messages (open API, no key; content credited to
// SR): every current message in one JSON document.
export const SR_TRAFFIC_URL =
  'https://api.sr.se/api/v2/traffic/messages?format=json&pagination=false';
const TTL_MS = 3 * 60_000;
/** How long SR is left alone after a failed refresh. */
export const SR_TRAFFIC_RETRY_AFTER_FAILURE_MS = 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Bounded SR traffic route for dev and preview. */
export function srTrafficProxy({
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
      const response = await fetchImpl(SR_TRAFFIC_URL, {
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
      return { ...normalizeSrMessages(payload), fetchedAt: now() };
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
   * One read of SR, shared by everyone waiting on it: the new snapshot, or
   * after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[sr-traffic] ${value.messages.length} messages`);
      return value;
    } catch (error) {
      console.warn(`[sr-traffic] refresh failed: ${error?.message || error}`);
      retryAfter = now() + SR_TRAFFIC_RETRY_AFTER_FAILURE_MS;
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
        : await coalesceProxyRequest(inFlight, 'messages', refresh).promise;
    if (!value) return json(502, { error: 'sr_traffic_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name: 'sr-traffic',
    configureServer({ middlewares }) {
      middlewares.use('/api/sr-traffic', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sr-traffic', handler);
    },
  };
}
