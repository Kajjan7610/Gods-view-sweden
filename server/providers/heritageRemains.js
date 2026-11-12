import {
  REMAINS_MAX_SPAN_DEG,
  normalizeRemains,
  remainsInView,
  snapToGrid,
} from '../../src/layers/heritageRemains/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Riksantikvarieämbetet's remains through its INSPIRE OGC API Features (no
// key, public domain, "inga begränsningar"). There are some 530 000, so
// nothing is downloaded whole: a view asks for its own box, widened to a
// 0.02-degree grid so nearby views share one answer, kept half a day.
export const RAA_REMAINS_URL =
  'https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/collections/kulturhistoriska_fornlamningar/items';
const USER_AGENT =
  'GodsEyeViewSverige/1.0 (+https://github.com/Kajjan7610/Gods-view-sweden)';
/** The most remains one box asks RAÄ for. */
export const UPSTREAM_LIMIT = 4000;
const TTL_MS = 12 * 60 * 60_000;
const MAX_ENTRIES = 48;
const MAX_BYTES = 24 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** After a failed request RAÄ is left alone this long. */
export const REMAINS_RETRY_AFTER_FAILURE_MS = 2 * 60_000;
const MAX_LIMIT = 2000;

const numbers = (value, count) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};
const onEarth = (lon, lat) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

/** Bounded RAÄ remains route for dev and preview. */
export function heritageRemainsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** Grid box key → {rows, capped, fetchedAt}; oldest first. */
  const cache = new Map();
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 600,
  });

  async function load(box) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url =
        `${RAA_REMAINS_URL}?f=application%2Fgeo%2Bjson` +
        `&limit=${UPSTREAM_LIMIT}&bbox=${box.join(',')}`;
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(response, MAX_BYTES);
      if (!Array.isArray(payload?.features))
        throw new Error('Malformed remains page');
      const matched = Number(payload.numberMatched);
      return {
        rows: normalizeRemains(payload.features),
        capped:
          payload.features.length >= UPSTREAM_LIMIT ||
          (Number.isFinite(matched) && matched > payload.features.length),
        fetchedAt: now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function remainsFor(box) {
    const key = box.join(',');
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < TTL_MS) return hit;
    if (now() < retryAfter) {
      if (hit) return { ...hit, stale: true };
      throw new Error('remains paused after a failure');
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, () => load(box));
      const value = await promise;
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      return value;
    } catch (error) {
      console.warn(`[heritage-remains] ${error?.message || error}`);
      retryAfter = now() + REMAINS_RETRY_AFTER_FAILURE_MS;
      if (hit) return { ...hit, stale: true };
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
    // The layer cuts its box to the span at 1e-4 degrees; the sliver allows
    // for the subtraction's own rounding.
    const widest = REMAINS_MAX_SPAN_DEG + 1e-9;
    if (bbox[2] - bbox[0] > widest || bbox[3] - bbox[1] > widest)
      return json(200, { tooWide: true, total: null, remains: [] });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    let value;
    try {
      value = await remainsFor(snapToGrid(bbox));
    } catch {
      return json(502, { error: 'remains_unavailable' });
    }
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit')) || 1500),
    );
    const view = remainsInView(value.rows, { bbox, center, limit });
    return json(
      200,
      {
        tooWide: false,
        capped: value.capped,
        fetchedAt: value.fetchedAt,
        stale: value.stale === true,
        ...view,
      },
      value.stale ? { 'X-Data-Stale': 'true' } : {},
    );
  }

  return {
    name: 'heritage-remains',
    configureServer({ middlewares }) {
      middlewares.use('/api/heritage-remains', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/heritage-remains', handler);
    },
  };
}
