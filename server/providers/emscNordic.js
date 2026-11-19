import { readCappedResponseText, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';

// Swedish fork: small earthquakes in the Nordic countries from the EMSC's
// FDSN event service (CC BY 4.0, credited "EMSC"). USGS's world feed only
// lists M2.5 and up, which leaves out nearly every quake felt in Sweden.
// The EMSC asks that its answers are cached for at most ten minutes and not
// mirrored in bulk: one box, one day as the layer's name says, read at most
// every five minutes.
export const EMSC_EVENTS_URL =
  'https://www.seismicportal.eu/fdsnws/event/1/query';
/** Sweden, Norway, Denmark, Finland and the seas between. */
export const NORDIC_BOX = Object.freeze({
  minlat: 54,
  maxlat: 72,
  minlon: 4,
  maxlon: 33,
});
const WINDOW_HOURS = 24;
const TTL_MS = 5 * 60_000;
/** The EMSC's own limit on keeping an answer. */
const STALE_MAX_MS = 10 * 60_000;
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_EVENTS = 500;
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';
/**
 * ISF event types kept: known, suspected, felt and damaging earthquakes.
 * Mining and chemical explosions (km, sm, kh, sh…) and other kinds are left
 * out, as are events without a type.
 */
const EARTHQUAKE_TYPES = new Set(['ke', 'se', 'fe', 'de']);

/** The query for the last day in the Nordic box. */
export function emscQueryUrl(now) {
  const params = new URLSearchParams({
    format: 'json',
    ...Object.fromEntries(
      Object.entries(NORDIC_BOX).map(([key, value]) => [key, String(value)]),
    ),
    starttime: new Date(now - WINDOW_HOURS * 3_600_000)
      .toISOString()
      .slice(0, 19),
    orderby: 'time',
    limit: String(MAX_EVENTS),
  });
  return `${EMSC_EVENTS_URL}?${params}`;
}

/** "SOUTHERN SWEDEN" as "Southern Sweden". */
const regionName = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase())
    .trim();

/** The EMSC's GeoJSON as the earthquakes the layer draws. */
export function normalizeEmscEvents(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const events = [];
  for (const feature of geojson.features) {
    const p = feature?.properties;
    if (!p || !EARTHQUAKE_TYPES.has(String(p.evtype ?? '').toLowerCase()))
      continue;
    // A missing magnitude is no M0.
    if (p.mag == null || p.mag === '') continue;
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const mag = Number(p.mag);
    // FDSN times are UTC; one written without a zone is read as UTC too.
    const stamp = String(p.time ?? '');
    const time = Date.parse(
      /(Z|[+-]\d\d:?\d\d)$/i.test(stamp) ? stamp : `${stamp}Z`,
    );
    if (![lat, lon, mag, time].every(Number.isFinite)) continue;
    const depth = Number(p.depth);
    events.push({
      id: String(p.unid ?? feature.id ?? `${p.time}:${lat}:${lon}`),
      lat,
      lon,
      depthKm: Number.isFinite(depth) ? Math.abs(depth) : null,
      mag,
      magType: typeof p.magtype === 'string' ? p.magtype.toUpperCase() : null,
      time,
      region: regionName(p.flynn_region) || null,
      auth: typeof p.auth === 'string' ? p.auth : null,
    });
  }
  return events.sort((a, b) => b.time - a.time);
}

/** Bounded EMSC route for dev and preview. */
export function emscNordicProxy({
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
      const response = await fetchImpl(emscQueryUrl(now()), {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      // FDSN answers 204 when nothing happened in the window.
      if (response.status === 204) return [];
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const { tooLarge, text } = await readCappedResponseText(
        response,
        MAX_BYTES,
      );
      if (tooLarge) throw new Error('upstream answer too large');
      const answer = JSON.parse(text);
      const events = normalizeEmscEvents(answer);
      if (!events) throw new Error('malformed EMSC answer');
      // How many the type filter kept, to see it never drops real quakes.
      console.log(
        `[emsc] ${events.length} of ${answer.features.length} Nordic events are earthquakes`,
      );
      return events;
    } finally {
      clearTimeout(timer);
    }
  }

  const fresh = (maxAge) => cached && now() - cached.savedAt < maxAge;

  async function read() {
    if (fresh(TTL_MS)) return cached.value;
    if (now() < retryAfter)
      return fresh(STALE_MAX_MS) ? { ...cached.value, stale: true } : null;
    return coalesceProxyRequest(inFlight, 'emsc', async () => {
      try {
        const events = await load();
        const value = { events, hours: WINDOW_HOURS, fetchedAt: now() };
        cached = { value, savedAt: now() };
        retryAfter = 0;
        return value;
      } catch (error) {
        console.warn(`[emsc] refresh failed: ${error?.message || error}`);
        retryAfter = now() + RETRY_AFTER_FAILURE_MS;
        return fresh(STALE_MAX_MS) ? { ...cached.value, stale: true } : null;
      }
    }).promise;
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
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const value = await read();
    return value ? json(200, value) : json(502, { error: 'emsc_unavailable' });
  }

  return {
    name: 'emsc-nordic',
    read,
    configureServer({ middlewares }) {
      middlewares.use('/api/emsc-nordic', sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/emsc-nordic', sameSiteGated(handler));
    },
  };
}
