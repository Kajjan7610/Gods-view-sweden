import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { createImageCredits } from './imageCredits.js';

// Sights around a town (Swedish fork): castles and palaces, churches,
// museums, ancient monuments and runestones, fortresses, lighthouses,
// waterfalls and nature reserves within reach of the seat, from Wikidata
// (CC0, no key) with their Swedish Wikipedia article and Commons image.
// Each town's list is kept a day.

export const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';
const TTL_MS = 24 * 60 * 60_000;
/** How long Wikidata is left alone after a failed read. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const RADIUS_KM = 12;
const MAX_SIGHTS = 40;
const PER_KIND = 8;
const CACHE_MAX = 200;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The kinds asked for, in the order a sight with several is filed under:
 * Wikidata class → kind.
 */
export const SIGHT_CLASSES = Object.freeze([
  ['Q16560', 'castle'], // palace
  ['Q23413', 'castle'],
  ['Q57821', 'fortress'],
  ['Q2977', 'church'], // cathedral
  ['Q16970', 'church'],
  ['Q33506', 'museum'],
  ['Q170980', 'runestone'],
  ['Q839954', 'ancient'], // archaeological site
  ['Q109607', 'ancient'], // ruins
  ['Q879050', 'manor'],
  ['Q4989906', 'monument'],
  ['Q34038', 'nature'], // waterfall
  ['Q46169', 'nature'], // national park
  ['Q179049', 'nature'], // nature reserve
  ['Q39715', 'lighthouse'],
]);
const KIND_ORDER = [...new Set(SIGHT_CLASSES.map(([, kind]) => kind))];
/** Kinds worth a visit on their own, ahead of the common ones. */
const NOTABLE = new Set([
  'castle',
  'fortress',
  'museum',
  'runestone',
  'ancient',
]);

/** The SPARQL query for sights within `km` of a point. */
export function sightsQuery(lat, lon, km = RADIUS_KM) {
  const values = SIGHT_CLASSES.map(
    ([qid, kind]) => `(wd:${qid} "${kind}")`,
  ).join(' ');
  return `SELECT ?item ?itemLabel ?kind ?coord ?image ?article WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${Number(lon).toFixed(5)} ${Number(lat).toFixed(5)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${km}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  VALUES (?class ?kind) { ${values} }
  ?item wdt:P31/wdt:P279? ?class .
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://sv.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "sv,en". }
}
ORDER BY ?dist
LIMIT 1500`;
}

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

/**
 * Wikidata's rows as one sight per item: its first kind in KIND_ORDER, its
 * position, image and Swedish article; the notable, described and pictured
 * first, then the nearest.
 */
export function normalizeSights(body, lat, lon, max = MAX_SIGHTS) {
  const rows = body?.results?.bindings ?? [];
  const byItem = new Map();
  for (const row of rows) {
    const qid = /Q\d+$/.exec(String(row?.item?.value ?? ''))?.[0];
    const point = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(
      String(row?.coord?.value ?? ''),
    );
    const name = String(row?.itemLabel?.value ?? '').trim();
    if (!qid || !point || !name || name === qid) continue;
    const kind = String(row?.kind?.value ?? '');
    const sight = byItem.get(qid) ?? {
      id: qid,
      name: name.slice(0, 80),
      kind,
      lon: Number(point[1]),
      lat: Number(point[2]),
      image: null,
      article: null,
    };
    if (KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(sight.kind))
      sight.kind = kind;
    const image = String(row?.image?.value ?? '');
    if (!sight.image && /^https?:\/\/commons\.wikimedia\.org\//.test(image))
      sight.image = image.replace(/^http:/, 'https:');
    const article = String(row?.article?.value ?? '');
    if (!sight.article && /^https:\/\/sv\.wikipedia\.org\//.test(article))
      sight.article = article;
    byItem.set(qid, sight);
  }
  const score = (sight) =>
    (sight.article ? 2 : 0) +
    (sight.image ? 1 : 0) +
    (NOTABLE.has(sight.kind) ? 1.5 : 0);
  // At most PER_KIND of one kind, so a town's many churches leave room.
  const perKind = new Map();
  return [...byItem.values()]
    .map((sight) => ({
      ...sight,
      km: Math.round(distanceKm(lat, lon, sight.lat, sight.lon) * 10) / 10,
    }))
    .sort((a, b) => score(b) - score(a) || a.km - b.km)
    .filter((sight) => {
      const count = (perKind.get(sight.kind) ?? 0) + 1;
      perKind.set(sight.kind, count);
      return count <= PER_KIND;
    })
    .slice(0, max);
}

/** Bounded sights route for dev and preview. */
export function citySightsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const kept = new Map();
  const retryAt = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });
  const imageCredits = createImageCredits({
    now,
    async getJson(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
        if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
        return await readResponseJsonCapped(response, MAX_BODY_BYTES);
      } finally {
        clearTimeout(timer);
      }
    },
  });

  /**
   * Each sight's picture with its author and licence; a picture without a
   * licence to name is left out. `failed` keeps the answer out of the cache.
   */
  async function withCredits(list) {
    const { credits, failed } = await imageCredits.lookup(
      list.map((sight) => sight.image),
    );
    return {
      failed,
      value: list.map((sight) => {
        if (!sight.image) return sight;
        const imageCredit = credits.get(sight.image) ?? null;
        return {
          ...sight,
          image: imageCredit ? sight.image : null,
          imageCredit,
        };
      }),
    };
  }

  async function read(lat, lon) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `${WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(sightsQuery(lat, lon))}`,
        {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            Accept: 'application/sparql-results+json',
            'User-Agent': USER_AGENT,
          },
        },
      );
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      return normalizeSights(
        await readResponseJsonCapped(response, MAX_BODY_BYTES),
        lat,
        lon,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function sights(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = kept.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    // After a failure Wikidata is left alone for a minute for this place.
    if (now() < (retryAt.get(key) ?? 0)) {
      if (hit) return hit.value;
      throw new Error('Wikidata did not answer a moment ago');
    }
    if (!inFlight.has(key))
      inFlight.set(
        key,
        read(lat, lon)
          .then(withCredits)
          .then(({ value, failed }) => {
            if (failed) return value;
            kept.set(key, { value, at: now() });
            if (kept.size > CACHE_MAX) kept.delete(kept.keys().next().value);
            retryAt.delete(key);
            return value;
          })
          .catch((error) => {
            retryAt.set(key, now() + RETRY_AFTER_FAILURE_MS);
            if (retryAt.size > CACHE_MAX)
              retryAt.delete(retryAt.keys().next().value);
            if (hit) return hit.value;
            throw error;
          })
          .finally(() => inFlight.delete(key)),
      );
    return inFlight.get(key);
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < 55 ||
      lat > 69.5 ||
      lon < 10 ||
      lon > 25
    )
      return json(400, { error: 'point_outside_sweden' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      return json(200, { sights: await sights(lat, lon), fetchedAt: now() });
    } catch (error) {
      console.warn(`[city-sights] ${error?.message}`);
      return json(502, { error: 'upstream_failed' });
    }
  }

  return {
    name: 'city-sights',
    configureServer({ middlewares }) {
      middlewares.use('/api/city-sights', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/city-sights', handler);
    },
  };
}
