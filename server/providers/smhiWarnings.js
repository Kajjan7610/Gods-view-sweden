import { normalizeWarnings } from '../../src/layers/smhiWarnings/records.js';
import {
  createCountyLookup,
  normalizeCrisisItems,
} from '../../src/layers/smhiWarnings/crisis.js';
import { createPlaceLookup } from '../../src/layers/policeEvents/records.js';
import { SWEDISH_MUNICIPALITIES } from './polisen/municipalities.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// SMHI's impact-based weather warnings (CC BY 4.0, no key): one public JSON
// document with every warning in effect or upcoming, polygons included.
export const SMHI_WARNINGS_URL =
  'https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json';
// Krisinformation.se (MSB, no key): VMAs in effect and recent crisis news,
// fetched with the warnings so everything serious sits in one layer.
export const KRIS_VMAS_URL = 'https://api.krisinformation.se/v3/vmas';
export const KRIS_NEWS_URL = 'https://api.krisinformation.se/v3/news?days=3';
const crisisLookups = {
  places: createPlaceLookup(SWEDISH_MUNICIPALITIES),
  counties: createCountyLookup(SWEDISH_MUNICIPALITIES),
};
const TTL_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Bounded SMHI warning route for dev and preview. */
export function smhiWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function getJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(
        `upstream HTTP ${response.status} (${new URL(url).host})`,
      );
    }
    return readResponseJsonCapped(response, MAX_BODY_BYTES);
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const [warnings, vmas, news] = await Promise.allSettled([
        getJson(SMHI_WARNINGS_URL, controller.signal),
        getJson(KRIS_VMAS_URL, controller.signal),
        getJson(KRIS_NEWS_URL, controller.signal),
      ]);
      if (warnings.status === 'rejected') throw warnings.reason;
      const fetchedAt = now();
      // Crisis messages are an addition: when Krisinformation fails, the
      // warnings still serve and the last crisis list is kept.
      const crisisOk =
        vmas.status === 'fulfilled' && news.status === 'fulfilled';
      if (!crisisOk)
        console.warn(
          `[smhi-warnings] krisinformation failed: ${
            (vmas.reason || news.reason)?.message || 'error'
          }`,
        );
      return {
        ...normalizeWarnings(warnings.value, fetchedAt),
        crisis: crisisOk
          ? normalizeCrisisItems(
              { vmas: vmas.value, news: news.value },
              crisisLookups,
            )
          : (cached?.value?.crisis ?? []),
        crisisStale: !crisisOk,
        fetchedAt,
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
      const { promise } = coalesceProxyRequest(inFlight, 'warnings', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(
        `[smhi-warnings] ${value.areas.length} warning areas, ${value.crisis.length} crisis messages`,
      );
      return json(200, value);
    } catch (error) {
      console.warn(
        `[smhi-warnings] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'smhi_warnings_unavailable' });
    }
  }

  return {
    name: 'smhi-warnings',
    configureServer({ middlewares }) {
      middlewares.use('/api/smhi-warnings', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/smhi-warnings', handler);
    },
  };
}
