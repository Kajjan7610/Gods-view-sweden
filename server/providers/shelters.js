import {
  SHELTERS_MAX_SPAN_DEG,
  normalizeShelters,
  sheltersInView,
} from '../../src/layers/shelters/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// MCF's INSPIRE download service for shelters (OGC API Features, no key, "no
// conditions apply"). Some 63,000 shelters come in pages of 10,000; the
// route fetches them once a day and answers each view from memory, so MCF
// sees one download a day however much the map moves.
export const MCF_SHELTERS_URL =
  'https://inspire.mcf.se/skyddsrum/ogc/features/v1/collections/US_civilProtectionSite/items?f=application%2Fgeo%2Bjson';
const PAGE = 10_000;
const MAX_PAGES = 12;
const TTL_MS = 24 * 60 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;
/** After a failed download MCF is left alone this long. */
export const SHELTERS_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_LIMIT = 2000;

const numbers = (value, count) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};
const onEarth = (lon, lat) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

/** Bounded MCF shelter route for dev and preview. */
export function sheltersProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 2400,
  });

  async function page(startIndex) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `${MCF_SHELTERS_URL}&limit=${PAGE}&startIndex=${startIndex}`,
        {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'application/geo+json' },
        },
      );
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      return await readResponseJsonCapped(response, MAX_PAGE_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const features = [];
    let matched = Infinity;
    for (let i = 0; i < MAX_PAGES && features.length < matched; i += 1) {
      const payload = await page(features.length);
      if (!Array.isArray(payload?.features))
        throw new Error('Malformed shelter page');
      if (Number.isFinite(payload.numberMatched))
        matched = payload.numberMatched;
      features.push(...payload.features);
      if (payload.features.length < PAGE) break;
    }
    if (Number.isFinite(matched) && features.length < matched)
      throw new Error('shelter collection larger than the page budget');
    const rows = normalizeShelters(features);
    if (!rows.length) throw new Error('empty shelter collection');
    return {
      rows,
      count: rows.length,
      places: rows.reduce((sum, row) => sum + (row.places || 0), 0),
      fetchedAt: now(),
    };
  }

  /** The last snapshot marked stale, or null once it is too old to serve. */
  const staleSnapshot = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  async function snapshot() {
    if (cached && now() - cached.savedAt < TTL_MS)
      return { ...cached.value, stale: false };
    if (now() < retryAfter) {
      const stale = staleSnapshot();
      if (stale) return stale;
      throw new Error('shelter download paused after a failure');
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'shelters', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[shelters] ${value.count} shelters, ${value.places} places`);
      return { ...value, stale: false };
    } catch (error) {
      console.warn(`[shelters] refresh failed: ${error?.message || error}`);
      retryAfter = now() + SHELTERS_RETRY_AFTER_FAILURE_MS;
      const stale = staleSnapshot();
      if (stale) return stale;
      throw error;
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
    const [path, search = ''] = (req.url || '/').split('?');
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const params = new URLSearchParams(search);
    const bbox = numbers(params.get('bbox'), 4);
    const center = numbers(params.get('center'), 2);
    if (
      !bbox ||
      !center ||
      bbox[0] >= bbox[2] ||
      bbox[1] >= bbox[3] ||
      !onEarth(bbox[0], bbox[1]) ||
      !onEarth(bbox[2], bbox[3]) ||
      !onEarth(...center)
    )
      return json(400, { error: 'bbox_and_center_required' });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    let value;
    try {
      value = await snapshot();
    } catch {
      return json(502, { error: 'shelters_unavailable' });
    }
    const base = {
      count: value.count,
      placesAll: value.places,
      fetchedAt: value.fetchedAt,
      stale: value.stale,
    };
    // The layer cuts its box to the span at 1e-4 degrees; the sliver allows
    // for the subtraction's own rounding.
    const widest = SHELTERS_MAX_SPAN_DEG + 1e-9;
    if (bbox[2] - bbox[0] > widest || bbox[3] - bbox[1] > widest)
      return json(
        200,
        { ...base, tooWide: true, total: null, places: null, shelters: [] },
        value.stale ? { 'X-Data-Stale': 'true' } : {},
      );
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit')) || 1500),
    );
    const view = sheltersInView(value.rows, { bbox, center, limit });
    return json(
      200,
      { ...base, tooWide: false, ...view },
      value.stale ? { 'X-Data-Stale': 'true' } : {},
    );
  }

  return {
    name: 'shelters',
    configureServer({ middlewares }) {
      middlewares.use('/api/shelters', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/shelters', handler);
    },
  };
}
