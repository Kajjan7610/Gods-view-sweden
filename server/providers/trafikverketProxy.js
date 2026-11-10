import { sameSiteGated } from './common/same-site.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Trafikverket's open traffic API (CC0 1.0). Every route POSTs an XML query
// whose LOGIN carries the key; the key is server-side only
// (TRAFIKVERKET_API_KEY) and travels in the request body, never in a URL.
export const TRAFIKVERKET_API_URL =
  'https://api.trafikinfo.trafikverket.se/v2/data.json';
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
/**
 * How long Trafikverket is left alone after a failed refresh; a refused key
 * is not sent again on every request.
 */
export const TRAFIKVERKET_RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export const xmlAttr = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** `<INCLUDE>` elements for the given fields. */
export const trafikverketIncludes = (fields, prefix = '') =>
  fields.map((f) => `<INCLUDE>${prefix}${f}</INCLUDE>`).join('');

/**
 * One bounded, cached GET route over a Trafikverket query, for dev and
 * preview. A failed refresh serves the last snapshot marked stale for up to
 * an hour and leaves Trafikverket alone for a minute; without a key the route
 * answers not_configured and never fetches.
 * @param {object} options
 * @param {string} options.name Plugin and log name, e.g. "trafikverket-roads".
 * @param {(key: string) => string} options.query The XML request body.
 * @param {(payload: object, fetchedAt: number) => object} options.normalize
 * @param {(value: object) => string} options.describe Log line for a refresh.
 * @param {string} options.keylessHint What the key would show, for the log.
 * @param {number} options.ttlMs
 */
export function trafikverketProxy({
  name,
  query,
  normalize,
  describe,
  keylessHint,
  ttlMs,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
}) {
  const route = `/api/${name}`;
  let cached = null;
  let retryAfter = 0;
  /** Whether the last failed refresh was Trafikverket refusing the key. */
  let keyRefused = false;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let keylessLogged = false;

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
        body: query(key),
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
      const payload = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      const fetchedAt = now();
      return { ...normalize(payload, fetchedAt), fetchedAt };
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
   * One read of Trafikverket, shared by everyone waiting on it: the new
   * snapshot, or after a failure the last one (null without one).
   */
  async function refresh(key) {
    try {
      const value = await load(key);
      cached = { value, savedAt: now() };
      retryAfter = 0;
      keyRefused = false;
      console.log(`[${name}] ${describe(value)}`);
      return value;
    } catch (error) {
      // The message names an HTTP status or Trafikverket's own refusal text,
      // never the request body, so the key stays private.
      console.warn(`[${name}] refresh failed: ${error?.message || error}`);
      retryAfter = now() + TRAFIKVERKET_RETRY_AFTER_FAILURE_MS;
      keyRefused = error?.status === 401 || error?.status === 403;
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
    const key = String(env.TRAFIKVERKET_API_KEY ?? '').trim();
    if (!key) {
      if (!keylessLogged) {
        keylessLogged = true;
        console.warn(
          `[${name}] skipped: set TRAFIKVERKET_API_KEY to show ${keylessHint}`,
        );
      }
      return json(
        503,
        { error: 'not_configured' },
        { 'Retry-After': '3600', 'X-Data-Backoff': 'not-configured' },
      );
    }
    if (cached && now() - cached.savedAt < ttlMs)
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    const value =
      now() < retryAfter
        ? lastKnown()
        : await coalesceProxyRequest(inFlight, name, () => refresh(key))
            .promise;
    if (!value)
      return json(502, {
        error: `${name.replace(/-/g, '_')}_unavailable`,
        keyRefused,
      });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name,
    configureServer({ middlewares }) {
      middlewares.use(route, sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(route, sameSiteGated(handler));
    },
  };
}
