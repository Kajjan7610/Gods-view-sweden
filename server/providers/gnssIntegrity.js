import {
  GNSS_CLASSIFIER,
  GNSS_WINDOW_MS,
  normalizeGnssAircraft,
} from '../../src/layers/gnss/records.js';
import { adsbLolFallbackAnchor } from './aircraft/opensky.js';
import { createAdsbLolUpstream } from './aircraft/adsbLolUpstream.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// adsb.lol regional snapshot (ODbL). Only the integrity fields the GNSS layer
// needs leave this proxy, so the browser never sees the full feed. This is a
// separate read from the flights fallback on purpose: that point cache keeps
// only the fields the flights layer renders (no nic / nac_p), is keyed on
// 0.25° anchors and lives for 12 s, while integrity cells need whole-degree
// anchors held for a minute. Swedish fork: the read goes through the adsb.lol
// transport the flights share (aircraft/adsbLolUpstream.js), so it uses the
// same key and lockout, and spends only its own 20 % of the day's budget,
// paced over the day.
const RADIUS_NM = 250;
const CACHE_MS = 60_000;
const CACHE_MAX = 64;
/** The least a failure holds the route back, on its own clock. */
const FAILURE_COOLDOWN_MS = 15_000;
const MAX_IN_FLIGHT = 8;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Snap a view anchor to a whole degree so nearby views share one upstream read. */
export function gnssIntegrityAnchor(url) {
  const anchor = adsbLolFallbackAnchor({ url });
  if (!anchor) return null;
  return {
    lat: Math.round(anchor.latitude),
    lon: Math.round(anchor.longitude),
  };
}

/**
 * Fixed-origin, bounded adsb.lol integrity route for dev and preview.
 * `adsbLol` is the transport every adsb.lol caller shares; without one the
 * route keeps its own, over `fetchImpl` and `now`.
 */
export function gnssIntegrityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  warn = (...args) => console.warn(...args),
  adsbLol = createAdsbLolUpstream({ fetchImpl, now, warn }),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cooldownUntil = 0;
  let cooldownStatus = 429;

  async function load({ lat, lon }) {
    if (monotonicNow() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), {
        status: cooldownStatus,
      });
    try {
      // The answer is checked as it is read, so an unusable one holds the
      // route back in the transport like any failed call.
      return await adsbLol.request(
        'gnss',
        `/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
        {
          userAgent: 'gods-eye-view-gnss-integrity/1.0',
          timeoutMs: TIMEOUT_MS,
          read: async (response, signal) => {
            const payload = await readResponseJsonCapped(
              response,
              MAX_RESPONSE_BYTES,
              signal,
            );
            const rows = normalizeGnssAircraft(payload);
            if (!rows) throw new Error('invalid_snapshot');
            const sourceNow = payload.now;
            if (!Number.isFinite(sourceNow) || sourceNow <= 0)
              throw new Error('undated_snapshot');
            const fetchedAt = Math.min(
              now(),
              sourceNow > 10_000_000_000 ? sourceNow : sourceNow * 1000,
            );
            if (now() - fetchedAt > GNSS_WINDOW_MS)
              throw new Error('expired_snapshot');
            return {
              fetchedAt,
              anchor: { lat, lon },
              radiusNm: RADIUS_NM,
              // `degraded` on each row is this classifier's verdict, not gpsjam's.
              classifier: GNSS_CLASSIFIER.id,
              rows,
            };
          },
        },
      );
    } catch (error) {
      if (error?.name === 'AdsbLolRefusal') {
        // The transport's wait, kept on this route's own clock: the shared
        // lockout and the daily budget answer 429, a failure 502.
        const quota = error.reason === 'locked' || error.reason === 'budget';
        const until =
          monotonicNow() +
          (quota
            ? error.retryAfterMs
            : Math.max(FAILURE_COOLDOWN_MS, error.retryAfterMs));
        if (quota) {
          cooldownStatus = 429;
          cooldownUntil = Math.max(cooldownUntil, until);
        } else if (until > cooldownUntil) {
          cooldownUntil = until;
          cooldownStatus = 502;
        }
        throw Object.assign(
          new Error(quota ? 'upstream_rate_limited' : 'upstream_unavailable'),
          { status: quota ? 429 : 502 },
        );
      }
      const until = monotonicNow() + FAILURE_COOLDOWN_MS;
      if (until > cooldownUntil) {
        cooldownUntil = until;
        cooldownStatus = 502;
      }
      throw error;
    }
  }

  function age(entry) {
    if (!entry) return Infinity;
    const elapsed = monotonicNow() - entry.savedAt;
    // A backwards injected clock cannot rejuvenate a snapshot.
    return elapsed < 0 ? Infinity : entry.ageAtReceipt + elapsed;
  }

  async function acquire(anchor, peer) {
    const key = `${anchor.lat},${anchor.lon}`;
    const previous = cache.get(key);
    // Swedish fork: a degree already read is read again only after the
    // transport's pacing gap for GNSS (its own slice of the day's budget,
    // spread over the day); meanwhile its rows are served with their age,
    // which the layer dates them by, well inside its 30 min window.
    if (age(previous) < Math.max(CACHE_MS, adsbLol.gapMs('gnss')))
      return { value: previous.value, ageMs: age(previous), stale: false };
    try {
      if (!inFlight.has(key) && inFlight.size >= MAX_IN_FLIGHT)
        throw Object.assign(new Error('busy'), { status: 429, local: true });
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        if (monotonicNow() >= cooldownUntil && !allow(peer))
          throw Object.assign(new Error('rate_limited'), {
            status: 429,
            local: true,
          });
        const value = await load(anchor);
        const entry = {
          value,
          savedAt: monotonicNow(),
          ageAtReceipt: Math.max(0, now() - value.fetchedAt),
        };
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return entry;
      });
      const entry = await promise;
      const ageMs = age(entry);
      return { value: entry.value, ageMs, stale: ageMs >= CACHE_MS };
    } catch (error) {
      if (age(previous) <= GNSS_WINDOW_MS)
        return { value: previous.value, ageMs: age(previous), stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false, retryAfterS = 60) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...([429, 502].includes(status)
          ? { 'Retry-After': String(retryAfterS) }
          : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const anchor = gnssIntegrityAnchor(req.url);
    if (!anchor) return json(400, { error: 'invalid_anchor' });
    try {
      const { value, stale, ageMs } = await acquire(anchor, clientKey(req));
      // ageMs is measured on this server's clock, so the browser can date
      // the rows without comparing its clock to ours.
      json(200, { ...value, ageMs, ...(stale ? { stale: true } : {}) }, stale);
    } catch (error) {
      if (error.status === 429) {
        // Tell the browser how long the shared upstream cooldown has left.
        const retryAfterS = Math.max(
          1,
          error.local ? 60 : Math.ceil((cooldownUntil - monotonicNow()) / 1000),
        );
        return json(
          429,
          {
            error: error.local ? error.message : 'gnss_integrity_rate_limited',
          },
          false,
          retryAfterS,
        );
      }
      json(
        502,
        { error: 'gnss_integrity_unavailable' },
        false,
        Math.max(1, Math.ceil((cooldownUntil - monotonicNow()) / 1000)),
      );
    }
  }

  return {
    name: 'gnss-integrity',
    configureServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
  };
}
