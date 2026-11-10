import {
  WINDOW_MS,
  normalizeStrikes,
} from '../../src/layers/lightningStrikes/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// DMI's open lightning API (CC BY 4.0, no key). One request covers the
// Nordic window for the last hour, newest first; strokes arrive within a few
// minutes, so a minute of cache keeps the layer live without hammering DMI.
// A failed read is left alone for a minute as well.
export const DMI_LIGHTNING_URL =
  'https://opendataapi.dmi.dk/v2/lightningdata/collections/observation/items';
const NORDIC_BBOX = '4,54,32,71';
const PAGE = 10_000;
const MAX_PAGES = 2;
const TTL_MS = 60_000;
/** How long DMI is left alone after a failed refresh. */
export const LIGHTNING_RETRY_AFTER_FAILURE_MS = 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 10 * 60_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export function dmiLightningUrl(nowMs, offset = 0) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = new URL(DMI_LIGHTNING_URL);
  url.search = new URLSearchParams({
    datetime: `${iso(nowMs - WINDOW_MS)}/${iso(nowMs)}`,
    bbox: NORDIC_BBOX,
    limit: String(PAGE),
    sortorder: 'observed,DESC',
    ...(offset ? { offset: String(offset) } : {}),
  }).toString();
  return url.href;
}

/** Bounded DMI lightning route for dev and preview. */
export function lightningStrikesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function page(nowMs, offset, signal) {
    const response = await fetchImpl(dmiLightningUrl(nowMs, offset), {
      signal,
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
    if (!Array.isArray(payload?.features))
      throw new Error('Malformed lightning collection');
    return payload.features;
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const nowMs = now();
      const features = [];
      let truncated = false;
      for (let index = 0; index < MAX_PAGES; index++) {
        const batch = await page(nowMs, index * PAGE, controller.signal);
        features.push(...batch);
        if (batch.length < PAGE) break;
        truncated = index === MAX_PAGES - 1;
      }
      return {
        strikes: normalizeStrikes(features, nowMs),
        windowMinutes: WINDOW_MS / 60_000,
        truncated,
        fetchedAt: nowMs,
      };
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
   * One read of DMI, shared by everyone waiting on it: the new snapshot, or
   * after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[lightning-strikes] ${value.strikes.length} strokes`);
      return value;
    } catch (error) {
      console.warn(
        `[lightning-strikes] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + LIGHTNING_RETRY_AFTER_FAILURE_MS;
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
        : await coalesceProxyRequest(inFlight, 'strikes', refresh).promise;
    if (!value) return json(502, { error: 'lightning_strikes_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name: 'lightning-strikes',
    configureServer({ middlewares }) {
      middlewares.use('/api/lightning-strikes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/lightning-strikes', handler);
    },
  };
}
