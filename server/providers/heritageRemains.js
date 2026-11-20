import {
  REMAINS_MAX_SPAN_DEG,
  normalizeRemains,
  remainsInView,
  snapToGrid,
} from '../../src/layers/heritageRemains/records.js';
import {
  PROTECTED_BUILDINGS_FILTER,
  areasInView,
  normalizeAll,
  normalizeBuilding,
  normalizeProtectionArea,
  normalizeWorldSite,
} from '../../src/layers/heritageRemains/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Riksantikvarieämbetet's remains through its INSPIRE OGC API Features (no
// key, public domain, "inga begränsningar"). There are some 840 000, so
// nothing is downloaded whole: a view asks for its own box, widened to a
// 0.02-degree grid so nearby views share one answer, kept half a day.
export const RAA_REMAINS_URL =
  'https://inspire-raa.metria.se/geoserver/Kulturhistoriska_lamningar/ogc/features/v1/collections/kulturhistoriska_fornlamningar/items';
// Protected buildings, the same way: a view's grid box from each of two
// collections of Bebyggelseregistret (CC0). The inventory is asked only for
// the protections in PROTECTED_TYPES (records.js) and is filtered
// again on arrival: it is mostly private homes without any protection.
export const RAA_BUILDINGS_URL =
  'https://inspire-raa.metria.se/geoserver/Bebyggelse/ogc/features/v1/collections/kulturhistoriskt_inventerad_bebyggelse/items';
export const RAA_PROTECTION_AREAS_URL =
  'https://inspire-raa.metria.se/geoserver/Bebyggelse/ogc/features/v1/collections/byggnadsminnen_skyddsomraden/items';
// Sweden's World Heritage sites: some fifteen, read whole and kept a week.
export const RAA_WORLD_HERITAGE_URL =
  'https://inspire-raa.metria.se/geoserver/Varldsarv_ogc/ogc/features/v1/collections/varldsarv_sverige/items';
const WORLD_LIMIT = 100;
const WORLD_TTL_MS = 7 * 24 * 60 * 60_000;
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
/** The most protection areas one view is answered with. */
const MAX_AREAS = 200;

const numbers = (value, count) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};
const onEarth = (lon, lat) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

/**
 * Bounded RAÄ heritage routes for dev and preview: remains (`/`), protected
 * buildings (`/buildings`), both per view, and the World Heritage sites
 * (`/world-heritage`).
 */
export function heritageRemainsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 600,
  });
  // The protected buildings' route has its own allowance: a view asks both.
  const allowBuildings = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 600,
  });

  /** One page of a collection: its rows and whether RAÄ held more. */
  async function load(url, normalize, limit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
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
      if (!Array.isArray(payload?.features)) throw new Error('Malformed page');
      const matched = Number(payload.numberMatched);
      return {
        rows: normalize(payload.features),
        capped:
          payload.features.length >= limit ||
          (Number.isFinite(matched) && matched > payload.features.length),
        fetchedAt: now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A collection kept by key: each key read once (coalesced), kept `ttl`,
   * the oldest dropped past MAX_ENTRIES; after a failure the collection is
   * left alone a while and a kept answer is served stale.
   */
  function store(label, ttl, read) {
    /** Key → {rows, capped, fetchedAt}; oldest first. */
    const cache = new Map();
    const inFlight = new Map();
    let retryAfter = 0;
    return async function rowsFor(key, ...args) {
      const hit = cache.get(key);
      if (hit && now() - hit.fetchedAt < ttl) return hit;
      if (now() < retryAfter) {
        if (hit) return { ...hit, stale: true };
        throw new Error(`${label} paused after a failure`);
      }
      try {
        const { promise } = coalesceProxyRequest(inFlight, key, () =>
          read(...args),
        );
        const value = await promise;
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > MAX_ENTRIES)
          cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        console.warn(`[heritage-${label}] ${error?.message || error}`);
        retryAfter = now() + REMAINS_RETRY_AFTER_FAILURE_MS;
        if (hit) return { ...hit, stale: true };
        throw error;
      }
    };
  }

  const boxUrl = (base, box, filter) =>
    `${base}?f=application%2Fgeo%2Bjson` +
    `&limit=${UPSTREAM_LIMIT}&bbox=${box.join(',')}` +
    (filter
      ? `&filter-lang=cql2-text&filter=${encodeURIComponent(filter)}`
      : '');
  const remainsFor = store('remains', TTL_MS, (box) =>
    load(boxUrl(RAA_REMAINS_URL, box), normalizeRemains, UPSTREAM_LIMIT),
  );
  const buildingsFor = store('buildings', TTL_MS, (box) =>
    load(
      boxUrl(RAA_BUILDINGS_URL, box, PROTECTED_BUILDINGS_FILTER),
      (features) => normalizeAll(features, normalizeBuilding),
      UPSTREAM_LIMIT,
    ),
  );
  const areasFor = store('protection-areas', TTL_MS, (box) =>
    load(
      boxUrl(RAA_PROTECTION_AREAS_URL, box),
      (features) => normalizeAll(features, normalizeProtectionArea),
      UPSTREAM_LIMIT,
    ),
  );
  const worldFor = store('world-heritage', WORLD_TTL_MS, () =>
    load(
      `${RAA_WORLD_HERITAGE_URL}?f=application%2Fgeo%2Bjson&limit=${WORLD_LIMIT}`,
      (features) => normalizeAll(features, normalizeWorldSite),
      WORLD_LIMIT,
    ),
  );

  /** The view a request names, or null when it names none. */
  function viewOf(params) {
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
      return null;
    // The layer cuts its box to the span at 1e-4 degrees; the sliver allows
    // for the subtraction's own rounding.
    const widest = REMAINS_MAX_SPAN_DEG + 1e-9;
    const tooWide = bbox[2] - bbox[0] > widest || bbox[3] - bbox[1] > widest;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit')) || 1500),
    );
    return { bbox, center, tooWide, limit };
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
    const params = new URLSearchParams(search);
    const staleHeader = (value) =>
      value.stale ? { 'X-Data-Stale': 'true' } : {};

    if (path === '/world-heritage') {
      if (!allowBuildings(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      let value;
      try {
        value = await worldFor('all');
      } catch {
        return json(502, { error: 'world_heritage_unavailable' });
      }
      return json(
        200,
        {
          fetchedAt: value.fetchedAt,
          stale: value.stale === true,
          sites: value.rows,
        },
        staleHeader(value),
      );
    }

    if (path === '/buildings') {
      const view = viewOf(params);
      if (!view) return json(400, { error: 'bbox_and_center_required' });
      if (view.tooWide)
        return json(200, {
          tooWide: true,
          total: null,
          buildings: [],
          areas: [],
        });
      if (!allowBuildings(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      const box = snapToGrid(view.bbox);
      const key = box.join(',');
      // One request per collection, side by side. The buildings carry the
      // answer; the protection areas are a bonus and may fail alone.
      const [readBuildings, readAreas] = await Promise.allSettled([
        buildingsFor(key, box),
        areasFor(key, box),
      ]);
      if (readBuildings.status !== 'fulfilled')
        return json(502, { error: 'buildings_unavailable' });
      const buildings = readBuildings.value;
      const areas =
        readAreas.status === 'fulfilled'
          ? readAreas.value
          : {
              rows: [],
              capped: false,
              stale: true,
              fetchedAt: buildings.fetchedAt,
            };
      const shown = remainsInView(buildings.rows, view);
      const stale = buildings.stale === true || areas.stale === true;
      return json(
        200,
        {
          tooWide: false,
          capped: buildings.capped || areas.capped,
          fetchedAt: Math.min(buildings.fetchedAt, areas.fetchedAt),
          stale,
          total: shown.total,
          buildings: shown.remains,
          areas: areasInView(areas.rows, { ...view, limit: MAX_AREAS }),
        },
        staleHeader({ stale }),
      );
    }

    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const view = viewOf(params);
    if (!view) return json(400, { error: 'bbox_and_center_required' });
    if (view.tooWide)
      return json(200, { tooWide: true, total: null, remains: [] });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    let value;
    try {
      const box = snapToGrid(view.bbox);
      value = await remainsFor(box.join(','), box);
    } catch {
      return json(502, { error: 'remains_unavailable' });
    }
    const shown = remainsInView(value.rows, view);
    return json(
      200,
      {
        tooWide: false,
        capped: value.capped,
        fetchedAt: value.fetchedAt,
        stale: value.stale === true,
        ...shown,
      },
      staleHeader(value),
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
