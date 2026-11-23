import fs from 'node:fs';
import os from 'node:os';
import {
  normalizeAdsbLolPointResponse,
  visibleAdsbLolAircraft,
} from '../../../src/data/adsbLolFallback.js';
import { encodedBody, gzipBody } from '../common/compress.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { requiredFiniteQueryNumber } from '../common/query.js';
import {
  clipViewExtent,
  usableViewExtent,
  viewExtentArea,
} from '../../../src/geo/viewExtent.js';
import {
  ADSBLOL_FLIGHTS_MAX_GAP_MS,
  createAdsbLolUpstream,
} from './adsbLolUpstream.js';
import {
  ADSBLOL_VIEW_MAX_KM,
  adsbLolViewPlan as planAdsbLolView,
  coveredShare,
  mergeAdsbLolDiscs,
  reachesWholeExtent,
} from './adsbLolView.js';
// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
let _openskyToken = null;
/** @type {number} Epoch-ms when the current token expires. */
let _openskyTokenExpiry = 0;
/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
let _openskyTokenPromise = null;
/** @type {string|null} Cached upstream response body (JSON text). */
let _openskyCacheBody = null;
/**
 * @type {Buffer|null} Gzip of `_openskyCacheBody`, written together with it.
 * Null when the body is not worth compressing.
 */
let _openskyCacheGzip = null;
/** @type {number} HTTP status of the cached response. */
let _openskyCacheStatus = 0;
/** @type {number} Epoch-ms when the response was cached. */
let _openskyCacheTime = 0;
/** @type {{requestedMode:string,usedMode:string,reason:string}|null} Auth metadata for the cached response. */
let _openskyCacheMeta = null;
/** @type {number|null} Source snapshot epoch from the cached OpenSky body. */
let _openskyCacheSourceEpochMs = null;
/** TTL for the OpenSky response cache (ms). */
const OPENSKY_CACHE_MS = 9000;
/** Per-attempt limit for the global snapshot; it normally arrives in ~1.5 s. */
const OPENSKY_ATTEMPT_TIMEOUT_MS = 10_000;
const OPENSKY_STATES_URL =
  'https://opensky-network.org/api/states/all?extended=1';
/** states/all?extended=1 measures ~0.8 MB anonymously; bounded, not budgeted. */
const OPENSKY_STATES_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Credit-governor cooldown for a 429: OpenSky's retry-after bounded to
 * 30 s … 30 min, or 2 min when the header is absent.
 * @param {Response} upstream Rate-limited response.
 * @returns {number} Cooldown (ms).
 */
function openSkyRateLimitCooldownMs(upstream) {
  // headers.get() gives null when absent, and Number(null) is 0, not NaN.
  const header = upstream.headers.get('x-rate-limit-retry-after-seconds');
  const retryAfterSec =
    header == null || header.trim() === '' ? NaN : Number(header);
  return Math.min(
    Math.max(
      Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 120_000,
      30_000,
    ),
    30 * 60_000,
  );
}

/**
 * Fetch and read the global snapshot, giving each attempt
 * OPENSKY_ATTEMPT_TIMEOUT_MS and retrying once when an attempt times out or
 * the connection fails. An oversized body is not retried: it would fail again
 * and spend more credits. A second failure throws, which the proxy answers
 * from its stale cache or the regional fallback.
 * @param {Record<string, string>} headers Request headers.
 * @returns {Promise<{upstream: Response, body: string}>}
 */
async function fetchOpenSkyStates(headers) {
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(OPENSKY_ATTEMPT_TIMEOUT_MS);
      const upstream = await fetch(OPENSKY_STATES_URL, { headers, signal });
      if (upstream.status === 429 || upstream.status >= 500) {
        // Start the cooldown from the headers and drop the rejected body
        // unread, so a stalled or oversized 429 body cannot skip it.
        _openskyCooldownUntil =
          Date.now() +
          (upstream.status === 429
            ? openSkyRateLimitCooldownMs(upstream)
            : 15000);
        _openskyCooldownStatus = upstream.status;
        void upstream.body?.cancel().catch(() => {});
        return {
          upstream,
          body: JSON.stringify({
            error:
              upstream.status === 429
                ? 'OpenSky rate limited.'
                : 'OpenSky upstream unavailable.',
          }),
        };
      }
      const body = await readResponseTextCapped(
        upstream,
        OPENSKY_STATES_MAX_RESPONSE_BYTES,
        signal,
      );
      return { upstream, body };
    } catch (error) {
      if (attempt >= 2 || error?.code === 'RESPONSE_TOO_LARGE') throw error;
      console.warn(
        '[OpenSky] global snapshot attempt failed, retrying:',
        error?.message || error,
      );
    }
  }
}
// --- OpenSky credit governor (field-test fix 2026-07-06) -------------------
// The global /states/all this proxy fetches costs 4 CREDITS per call against
// OpenSky's ~4000/day authenticated budget — a day with the app open burned
// the whole quota in ~8h and the layer then hard-died until the daily reset
// ("rate limited for 48h" owner report; auth itself was fine). Three levers:
//  1. Adaptive TTL: OpenSky returns X-Rate-Limit-Remaining on success; as the
//     budget thins, the proxy stretches its cache TTL so a full day of
//     continuous use never exhausts it.
//  2. 429 cooldown: honor X-Rate-Limit-Retry-After-Seconds — no upstream
//     attempts until it passes (bounded 30 s … 30 min).
//  3. Serve-stale: while rate-limited/cooling, serve the last-good body (200 +
//     X-OpenSky-Stale) so the layer keeps rendering instead of dying.
/** @type {number} Current adaptive TTL (ms) — starts at the base cache TTL. */
let _openskyTtlMs = OPENSKY_CACHE_MS;
/** @type {number} Epoch-ms before which no upstream fetch is attempted. */
let _openskyCooldownUntil = 0;
let _openskyCooldownStatus = 429;
const _openskySnapshotInFlight = new Map();
/**
 * Picks the cache TTL from the remaining daily credit budget.
 * Client polls every 30 s, so tiers ≤30 s cost the same 480 credits/h; the
 * later tiers stretch the day: >2400 → ~3 h of full freshness, then 30 s
 * (~2.5 h), 90 s (~5 h), 300 s (~8 h) ≈ 18+ h of continuous use per day.
 * @param {number} remaining - X-Rate-Limit-Remaining header value.
 * @returns {number} TTL in ms.
 */
function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}
/** @type {boolean} Guards duplicate auth-failure warnings in logs. */
let _openskyAuthWarned = false;
/** One warning per process when OPENSKY_CREDENTIALS_FILE cannot be read. */
let _openskyCredentialsFileWarned = false;
/** One warning per process when OPENSKY_AUTH_MODE=basic is requested. */
let _openskyBasicRetiredWarned = false;
/** @type {boolean} Guards duplicate invalid-auth-mode warnings. */
let _openskyAuthModeWarned = false;
/** Default auth mode when OPENSKY_AUTH_MODE env is unset. */
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
/** Set of valid OPENSKY_AUTH_MODE values. */
const OPENSKY_AUTH_MODE_SET = new Set(['basic', 'oauth', 'auto', 'anon']);
/**
 * Whether flights come from adsb.lol alone: open data under ODbL, read around
 * the view, and OpenSky is never asked. The Swedish version's default;
 * FLIGHTS_SOURCE=opensky brings OpenSky back, whose terms need a written
 * licence for live use.
 */
export function flightsFromAdsbLol(env = process.env) {
  return (
    String(env.FLIGHTS_SOURCE ?? '')
      .trim()
      .toLowerCase() !== 'opensky'
  );
}
/**
 * Regional civilian fallback cache, keyed by a coarse 0.25° view anchor, or
 * by a whole view's lattice disc (Swedish fork, adsbLolView.js).
 */
const _adsbLolPointCache = new Map();
/** Per-anchor single-flight map for concurrent regional fallback requests. */
const _adsbLolPointInFlight = new Map();
const ADSBLOL_POINT_CACHE_MS = 12000;
const ADSBLOL_POINT_CACHE_MAX = 80;
const ADSBLOL_POINT_RADIUS_NM = 250;
/** What the flights cover when adsb.lol is the source ("regional" tells tools). */
const ADSBLOL_VIEW_COVERAGE = `${ADSBLOL_POINT_RADIUS_NM}nm regional feed around the view`;
const ADSBLOL_POINT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Swedish fork: while adsb.lol's quota is spent (or it fails), a request is
// answered with the newest disc whose anchor lies within the disc's own
// radius of it, and never with one older than this: an aircraft's position
// half an hour old says little of where it is.
const ADSBLOL_STALE_REACH_KM = ADSBLOL_POINT_RADIUS_NM * 1.852;
const ADSBLOL_STALE_MAX_MS = 30 * 60_000;
// A request this close to a disc read within the pacing gap is the same
// place: that disc is served, paced, whichever cell it was read for.
const ADSBLOL_SAME_PLACE_KM = 50;
// Swedish fork: whole views merged from several discs (adsbLolView.js), by
// their discs and the minute, a few at a time.
const _adsbLolViewCache = new Map();
const ADSBLOL_VIEW_CACHE_MAX = 8;
/** When an outer disc that failed was last tried, by its cache key. */
const _adsbLolOuterTries = new Map();
/** An outer disc read within this many of its gaps is read on time. */
const ADSBLOL_OUTER_LATE = 1.5;
/** An aircraft read longer ago than the centre's gap and this is aged. */
const ADSBLOL_AGED_MARGIN_MS = 60_000;
// A 200 response can still contain an old OpenSky snapshot. Past this point
// the viewport-scoped adsb.lol source is more honest and keeps local motion
// current instead of coasting a stale worldwide frame indefinitely.
const OPENSKY_SOURCE_STALE_MS = 120_000;

/**
 * The OpenSky API client for OAuth: OPENSKY_CLIENT_ID and
 * OPENSKY_CLIENT_SECRET, or else the credentials.json that OpenSky's account
 * page downloads, named by OPENSKY_CREDENTIALS_FILE ("~" is the home
 * directory). The file is read on each token refresh, so a replaced file is
 * picked up without a restart.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {(path: string) => string} [readFile]
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function openSkyClientCredentials(
  env = process.env,
  readFile = (path) => fs.readFileSync(path, 'utf8'),
) {
  const clientId = String(env.OPENSKY_CLIENT_ID || '').trim();
  const clientSecret = String(env.OPENSKY_CLIENT_SECRET || '').trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const file = String(env.OPENSKY_CREDENTIALS_FILE || '').trim();
  if (!file) return null;
  const path = file.replace(/^~(?=$|[\\/])/, os.homedir());
  let raw;
  try {
    raw = JSON.parse(readFile(path));
  } catch {
    if (!_openskyCredentialsFileWarned) {
      console.warn(
        '[OpenSky] OPENSKY_CREDENTIALS_FILE could not be read or parsed as JSON.',
      );
      _openskyCredentialsFileWarned = true;
    }
    return null;
  }
  const fileId = String(raw?.clientId ?? raw?.client_id ?? '').trim();
  const fileSecret = String(
    raw?.clientSecret ?? raw?.client_secret ?? '',
  ).trim();
  return fileId && fileSecret
    ? { clientId: fileId, clientSecret: fileSecret }
    : null;
}

/**
 * Obtain a valid OpenSky OAuth2 bearer token, refreshing if needed.
 *
 * Uses the client_credentials grant against the OpenSky Keycloak realm.
 * Concurrent callers share a single in-flight refresh promise so only
 * one token request is issued at a time.
 *
 * @returns {Promise<string|null>} Bearer token string, or null if unavailable.
 */
export async function getOpenSkyToken() {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const credentials = openSkyClientCredentials();
  if (!credentials) return null;
  const { clientId, clientSecret } = credentials;

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  _openskyTokenPromise = (async () => {
    try {
      const res = await fetch(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(OPENSKY_ATTEMPT_TIMEOUT_MS),
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        },
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          const detail =
            data?.error_description || data?.error || `HTTP ${res.status}`;
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        return null;
      }

      _openskyToken = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _openskyTokenExpiry =
        Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      console.log(
        '[OpenSky] OAuth token refreshed, expires in',
        Number.isFinite(expiresIn) ? expiresIn : 1800,
        's',
      );
      _openskyAuthWarned = false;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn(
          '[OpenSky] OAuth token request failed:',
          err?.message || String(err),
        );
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}

/**
 * Validate and normalize the OPENSKY_AUTH_MODE env value.
 *
 * @param {string} value - Raw env value (e.g. 'basic', 'oauth', 'auto', 'anon').
 * @returns {string} One of the valid mode strings, or the default ('oauth').
 */
function normalizeOpenSkyAuthMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return OPENSKY_AUTH_MODE_DEFAULT;
  if (OPENSKY_AUTH_MODE_SET.has(raw)) return raw;
  if (!_openskyAuthModeWarned) {
    console.warn(
      `[OpenSky] Invalid OPENSKY_AUTH_MODE="${raw}", defaulting to "${OPENSKY_AUTH_MODE_DEFAULT}"`,
    );
    _openskyAuthModeWarned = true;
  }
  return OPENSKY_AUTH_MODE_DEFAULT;
}

/**
 * Build standard response headers for OpenSky proxy responses.
 *
 * Includes diagnostic X-OpenSky-* headers so the client can inspect
 * cache hit/miss status and which auth mode was actually used.
 *
 * @param {object} opts
 * @param {string} opts.cacheStatus - 'HIT', 'MISS', or 'STALE'.
 * @param {string} opts.requestedMode - The auth mode the config requested.
 * @param {string} opts.usedMode - The auth mode actually used for the upstream call.
 * @param {string} opts.reason - Human-readable reason string for diagnostics.
 * @returns {Record<string,string>} Header object.
 */
function buildOpenSkyHeaders({
  cacheStatus,
  requestedMode,
  usedMode,
  reason,
  staleSeconds,
  retryAfterSeconds,
}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
  // Credit-governor extras (field-test fix 2026-07-06): the client can show a
  // STALE cue / countdown without parsing the body.
  if (Number.isFinite(staleSeconds))
    headers['X-OpenSky-Stale-Seconds'] = String(Math.round(staleSeconds));
  if (Number.isFinite(retryAfterSeconds))
    headers['X-OpenSky-Retry-After-Seconds'] = String(
      Math.round(retryAfterSeconds),
    );
  return headers;
}

export function adsbLolFallbackAnchor(req) {
  const incoming = new URL(req?.url || '', 'http://localhost');
  const latitude = requiredFiniteQueryNumber(incoming.searchParams, 'lat');
  const longitude = requiredFiniteQueryNumber(incoming.searchParams, 'lon');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    return null;
  return { latitude, longitude };
}

/** Great-circle kilometres between two `{latitude, longitude}` points. */
function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * toRad) *
      Math.cos(b.latitude * toRad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The cached disc whose anchor lies within `withinKm` of the point and that
 * is no older than `maxAgeMs` (younger than it when `younger`): the newest
 * such, or the nearest; null when none is. With `centresOnly` a whole
 * view's outer discs are left out.
 */
function cachedAdsbLolDisc(
  anchor,
  now,
  { withinKm, maxAgeMs, younger = false, nearest = false, centresOnly = false },
) {
  let best = null;
  let bestKm = Infinity;
  for (const record of _adsbLolPointCache.values()) {
    if (centresOnly && record.kind === 'outer') continue;
    const age = now - record.cachedAt;
    if (younger ? age >= maxAgeMs : age > maxAgeMs) continue;
    const km = distanceKm(anchor, record.anchor);
    if (km > withinKm) continue;
    if (best && (nearest ? km >= bestKm : record.cachedAt <= best.cachedAt))
      continue;
    best = record;
    bestKm = km;
  }
  return best;
}

/**
 * When the newest disc was read, any place's; 0 with none. An outer disc of
 * a whole view does not count: it never stands in for asking the place in
 * view.
 */
function newestAdsbLolDiscAt() {
  let newest = 0;
  for (const record of _adsbLolPointCache.values())
    if (record.kind !== 'outer') newest = Math.max(newest, record.cachedAt);
  return newest;
}

/** The newest disc in reach of the point, for when none can be asked for. */
function staleAdsbLolDisc(anchor, now) {
  const newest = cachedAdsbLolDisc(anchor, now, {
    withinKm: ADSBLOL_STALE_REACH_KM,
    maxAgeMs: ADSBLOL_STALE_MAX_MS,
  });
  return newest ? { ...newest, cacheStatus: 'STALE' } : null;
}

/**
 * Read one adsb.lol disc through the shared transport as `kind` (the flights
 * around the point in view, or an outer disc of a whole view) and keep it
 * under `cacheKey`; a call already on its way for the key is joined.
 * @returns {{promise: Promise<object>, shared: boolean}}
 */
function readAdsbLolDisc(adsbLol, kind, cacheKey, anchor) {
  return coalesceProxyRequest(_adsbLolPointInFlight, cacheKey, async () => {
    const payload = await adsbLol.request(
      kind,
      `/v2/lat/${anchor.latitude}/lon/${anchor.longitude}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
      {
        userAgent: 'gods-eye-view-adsblol-regional-fallback/1.0',
        timeoutMs: 10_000,
        read: (upstream, signal) =>
          readResponseJsonCapped(
            upstream,
            ADSBLOL_POINT_MAX_RESPONSE_BYTES,
            signal,
          ),
      },
    );
    const normalized = normalizeAdsbLolPointResponse(payload);
    const body = JSON.stringify(normalized);
    // Left out by the normalizer: owners who asked not to be shown, and
    // military aircraft. Their addresses, so a whole view counts each once.
    const rows = Array.isArray(payload?.ac) ? payload.ac : [];
    const visible = new Set(visibleAdsbLolAircraft(rows));
    const hiddenHex = rows
      .filter((row) => !visible.has(row))
      .map(
        (row, index) =>
          String(row?.hex ?? '')
            .trim()
            .toLowerCase() || `#${cacheKey}#${index}`,
      );
    const record = {
      body,
      // Compressed once per entry; ADSBLOL_POINT_CACHE_MAX bounds the
      // extra memory.
      gzip: await gzipBody(body),
      cachedAt: Date.now(),
      // When adsb.lol observed it, to weigh it against another frame.
      observedAtMs: normalized.time * 1000,
      anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
      count: normalized.states.length,
      privacyHidden: hiddenHex.length,
      hiddenHex,
      kind,
    };
    _adsbLolPointCache.delete(cacheKey);
    _adsbLolPointCache.set(cacheKey, record);
    while (_adsbLolPointCache.size > ADSBLOL_POINT_CACHE_MAX) {
      _adsbLolPointCache.delete(_adsbLolPointCache.keys().next().value);
    }
    return record;
  });
}

/**
 * The adsb.lol disc around the request's place, through the shared transport
 * (adsbLolUpstream.js). Resolves null without a place; a disc to serve, with
 * its `cacheStatus` (HIT from this cell's cache; PACED from the same place's,
 * read within the pacing gap; MISS or INFLIGHT fresh; STALE from a disc in
 * reach when none could, or should, be asked for); or `{refusal}`, why there
 * is nothing to serve. `centreGapMs`, a whole view's gap for its centre
 * (viewPace), stands in for the flights' own.
 */
async function fetchAdsbLolPointFallback(req, adsbLol, centreGapMs = null) {
  const anchor = adsbLolFallbackAnchor(req);
  if (!anchor) return null;
  const roundedLat = Math.round(anchor.latitude * 4) / 4;
  const roundedLon = Math.round(anchor.longitude * 4) / 4;
  const cacheKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const cached = _adsbLolPointCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ADSBLOL_POINT_CACHE_MS) {
    return { ...cached, cacheStatus: 'HIT' };
  }
  // A call already on its way for this cell is joined before any check of
  // the budget: it is spent already.
  if (!_adsbLolPointInFlight.has(cacheKey)) {
    const held = adsbLol.admit('flights', now);
    // Swedish fork: locked out by adsb.lol, the newest disc in reach is
    // served as STALE, this cell's own included.
    if (held?.reason === 'locked')
      return staleAdsbLolDisc(anchor, now) ?? { refusal: held };
    // The same place is asked again only after the pacing gap, so the day's
    // quota lasts: within ADSBLOL_SAME_PLACE_KM of a disc read since, that
    // disc is served, with its age and where it was read.
    const gapMs = centreGapMs ?? adsbLol.gapMs('flights', now);
    const paced = cachedAdsbLolDisc(anchor, now, {
      withinKm: ADSBLOL_SAME_PLACE_KM,
      maxAgeMs: gapMs,
      younger: true,
    });
    if (paced) return { ...paced, cacheStatus: 'PACED', gapMs };
    if (held) return staleAdsbLolDisc(anchor, now) ?? { refusal: held };
    // A new place (or the same one, its gap passed) is asked at once only
    // while the budget keeps the pace's reserve (roomForNew). Past that, the
    // nearest disc in reach read within the gap is served; and while any
    // call went out within the gap, the nearest in reach up to 30 minutes
    // old, so places far apart share one pace. With none, the place is
    // asked, as a paced call. Swedish fork: the gap is the flights' own
    // here, never a whole view's longer one, and a whole view's outer discs
    // never stand in, so another place's calls do not keep a zoomed-out
    // centre on old data.
    if (!adsbLol.roomForNew('flights', now)) {
      const shareGapMs = adsbLol.gapMs('flights', now);
      const reach = {
        withinKm: ADSBLOL_STALE_REACH_KM,
        nearest: true,
        centresOnly: true,
      };
      const nearby =
        cachedAdsbLolDisc(anchor, now, {
          ...reach,
          maxAgeMs: shareGapMs,
          younger: true,
        }) ??
        (newestAdsbLolDiscAt() > now - shareGapMs
          ? cachedAdsbLolDisc(anchor, now, {
              ...reach,
              maxAgeMs: ADSBLOL_STALE_MAX_MS,
            })
          : null);
      if (nearby) return { ...nearby, cacheStatus: 'STALE' };
    }
  }

  const request = readAdsbLolDisc(adsbLol, 'flights', cacheKey, {
    latitude: roundedLat,
    longitude: roundedLon,
  });
  try {
    const record = await request.promise;
    return { ...record, cacheStatus: request.shared ? 'INFLIGHT' : 'MISS' };
  } catch (error) {
    if (!request.shared && error?.name !== 'AbortError') {
      console.warn(
        '[adsb.lol Flights Fallback]',
        `${error?.message || error}${error?.cause?.message ? `: ${error.cause.message}` : ''}`,
      );
    }
    const failedAt = Date.now();
    return (
      staleAdsbLolDisc(anchor, failedAt) ?? {
        refusal:
          error?.name === 'AdsbLolRefusal'
            ? error
            : (adsbLol.admit('flights', failedAt) ?? {
                reason: 'failed',
                status: 502,
                until: failedAt + 60_000,
                retryAfterMs: 60_000,
              }),
      }
    );
  }
}

/**
 * The view the request names (`bbox=west,south,east,north`, degrees),
 * clipped around its place, with whether that cut any of it away and how
 * large the part kept is against the whole; null without one, or for one
 * that spans every longitude (the whole globe, a pole).
 */
function adsbLolViewExtent(req, lookAt) {
  const raw = new URL(req?.url || '', 'http://localhost').searchParams.get(
    'bbox',
  );
  const parts = String(raw ?? '').split(',');
  if (parts.length !== 4) return null;
  const [west, south, east, north] = parts.map((part) =>
    part.trim() === '' ? NaN : Number(part),
  );
  const named = usableViewExtent({ west, south, east, north });
  const extent = named && clipViewExtent(named, lookAt, ADSBLOL_VIEW_MAX_KM);
  if (!extent) return null;
  const ratio = Math.min(1, viewExtentArea(extent) / viewExtentArea(named));
  return { extent, clipped: ratio < 1 - 1e-9, ratio };
}

/**
 * The view's discs merged into one answer, the centre's first (`centre`
 * marks it), kept a minute: within it no other disc's aircraft passes the
 * age cap, as every one kept is younger than the cap at the minute's end.
 * Aircraft read longer ago than the centre's gap and a minute are named
 * aged. Past the most an answer gives, those nearest the look-at point.
 */
async function mergedAdsbLolView(entries, lookAt, now, centreGapMs) {
  const minute = Math.floor(now / 60_000);
  const agedAfterMs =
    Math.round(centreGapMs / 60_000) * 60_000 + ADSBLOL_AGED_MARGIN_MS;
  const key = [
    `${lookAt.latitude.toFixed(2)},${lookAt.longitude.toFixed(2)}`,
    minute,
    agedAfterMs,
    ...entries.map(
      ({ record, centre }) =>
        `${centre ? 'c' : 'o'}${record.anchor.latitude},${record.anchor.longitude}@${record.cachedAt}`,
    ),
  ].join('|');
  const cached = _adsbLolViewCache.get(key);
  if (cached) return cached;
  const merged = mergeAdsbLolDiscs(
    entries.map(({ record, centre }) => ({
      payload: JSON.parse(record.body),
      hidden: record.hiddenHex ?? [],
      anchor: record.anchor,
      centre,
    })),
    lookAt,
    {
      notBeforeS: ((minute + 1) * 60_000 - ADSBLOL_STALE_MAX_MS) / 1000,
      agedBeforeS: (minute * 60_000 - agedAfterMs) / 1000,
    },
  );
  const body = JSON.stringify(merged.payload);
  const view = {
    body,
    gzip: await gzipBody(body),
    count: merged.count,
    seen: merged.seen,
    privacyHidden: merged.privacyHidden,
  };
  _adsbLolViewCache.set(key, view);
  while (_adsbLolViewCache.size > ADSBLOL_VIEW_CACHE_MAX)
    _adsbLolViewCache.delete(_adsbLolViewCache.keys().next().value);
  return view;
}

/** Note an outer disc that failed: it waits its gap before it is tried again. */
function triedAdsbLolOuter(key, at) {
  _adsbLolOuterTries.delete(key);
  _adsbLolOuterTries.set(key, at);
  while (_adsbLolOuterTries.size > ADSBLOL_POINT_CACHE_MAX)
    _adsbLolOuterTries.delete(_adsbLolOuterTries.keys().next().value);
}

/**
 * Swedish fork: the whole view the request names, when it is larger than
 * the centre disc (adsbLolView.js), or null: where it is, how much of it was
 * cut away around the look-at point, the outer discs it needs, nearest the
 * look-at point first, the points its coverage is judged on, and the pace
 * they share with the centre (viewPace), known before the centre is asked.
 * The centre is weighed only against the outer discs read on time.
 */
function adsbLolViewPlan(req, adsbLol) {
  const lookAt = adsbLolFallbackAnchor(req);
  const view = lookAt ? adsbLolViewExtent(req, lookAt) : null;
  if (!view) return null;
  // The centre disc's own cell, wherever the disc served was read: the
  // view's discs depend on where it is, not on what was kept.
  const cell = {
    latitude: Math.round(lookAt.latitude * 4) / 4,
    longitude: Math.round(lookAt.longitude * 4) / 4,
  };
  const { discs: planned, points } = planAdsbLolView(lookAt, view.extent, cell);
  if (!planned.length) return null;
  const now = Date.now();
  const live = (kept, outerMs) =>
    planned.slice(0, kept).filter((disc) => {
      const record = _adsbLolPointCache.get(disc.key);
      return record && now - record.cachedAt <= outerMs * ADSBLOL_OUTER_LATE;
    }).length;
  return {
    lookAt,
    cell,
    planned,
    points,
    view,
    pace: adsbLol.viewPace(planned.length, now, live),
  };
}

/**
 * Swedish fork: the whole view around the centre disc served. The outer
 * discs are served from what was read, up to 30 min old; of those the pace
 * keeps, at most one is asked per answer: the nearest the look-at point
 * that was never read or was read (or tried, when it failed) longer ago
 * than its gap, while the transport has room for it (roomForOuter). The
 * answer is the centre's, with every disc's aircraft, how many of the
 * view's discs it holds and keeps, how much of the view they cover, their
 * gaps, whether the outer discs are held back, and when the oldest disc but
 * the centre's was read.
 */
async function wholeAdsbLolView(plan, centre, adsbLol) {
  const { lookAt, cell, planned, points, view, pace } = plan;
  const now = Date.now();
  const kept = planned.slice(0, pace.kept);
  const lastTry = (disc) =>
    Math.max(
      _adsbLolPointCache.get(disc.key)?.cachedAt ?? 0,
      _adsbLolOuterTries.get(disc.key) ?? 0,
    );
  const due = kept.find((disc) => now - lastTry(disc) >= pace.outerMs);
  // A call already on its way for the disc is joined: it is spent already.
  if (
    due &&
    (_adsbLolPointInFlight.has(due.key) || adsbLol.roomForOuter(now))
  ) {
    const request = readAdsbLolDisc(adsbLol, 'outer', due.key, due);
    try {
      await request.promise;
      _adsbLolOuterTries.delete(due.key);
    } catch (error) {
      if (!request.shared) {
        // A disc that fails waits its gap; the farther ones go on meanwhile.
        triedAdsbLolOuter(due.key, Date.now());
        if (error?.name !== 'AbortError')
          console.warn(
            '[adsb.lol Flights Whole View]',
            `${error?.message || error}${error?.cause?.message ? `: ${error.cause.message}` : ''}`,
          );
      }
    }
  }
  const at = Date.now();
  const usable = (record) =>
    record && at - record.cachedAt <= ADSBLOL_STALE_MAX_MS;
  const outer = planned
    .map((disc) => _adsbLolPointCache.get(disc.key))
    .filter(usable);
  // A centre served from another disc (STALE, the newest in reach) keeps
  // the point's own disc too while it is young enough; each disc is merged
  // once.
  const own = _adsbLolPointCache.get(
    `${cell.latitude.toFixed(2)},${cell.longitude.toFixed(2)}`,
  );
  const same = (a) => (b) =>
    a.cachedAt === b.record.cachedAt &&
    a.anchor.latitude === b.record.anchor.latitude &&
    a.anchor.longitude === b.record.anchor.longitude;
  const entries = [{ record: centre, centre: true }];
  for (const record of [...(usable(own) ? [own] : []), ...outer])
    if (!entries.some(same(record))) entries.push({ record, centre: false });
  const merged = await mergedAdsbLolView(entries, lookAt, at, pace.centreMs);
  const anchors = entries.map(({ record }) => record.anchor);
  const { share, uncovered } = coveredShare(points, anchors);
  // The whole view only when nothing in it is left out, between the points
  // either, nor cut away.
  const whole =
    uncovered === 0 &&
    !view.clipped &&
    reachesWholeExtent(view.extent, anchors);
  const others = entries.slice(1).map(({ record }) => record.cachedAt);
  return {
    ...centre,
    ...merged,
    discs: {
      shown: Math.min(1 + planned.length, entries.length),
      total: 1 + planned.length,
      kept: 1 + pace.kept,
    },
    pace,
    outerHeld: kept.length > 0 && !adsbLol.roomForOuter(at),
    view: {
      covered: whole ? 100 : Math.min(99, Math.floor(share * view.ratio * 100)),
      clipped: view.clipped,
    },
    outerCachedAt: others.length ? Math.min(...others) : null,
  };
}

/**
 * What a flights answer says of adsb.lol's daily budget: calls used of the
 * limit, whether calls go with a key, whether adsb.lol refused the key set
 * (calls go without it meanwhile) and until when no flights call may be
 * sent. A 200 says the last only for adsb.lol's own lock, or for a budget
 * that frees later than the longest pacing gap (sooner, the flights refresh
 * as paced); a refusal always says it. Never the key itself.
 */
function adsbLolBudgetHeaders(adsbLol, refusal = null) {
  const { keyed, keyRefused, used, limit } = adsbLol.status();
  const held = refusal ?? adsbLol.admit('flights');
  const quota =
    held?.reason === 'locked' ||
    (held?.reason === 'budget' &&
      (refusal !== null || held.retryAfterMs > ADSBLOL_FLIGHTS_MAX_GAP_MS));
  return {
    'X-ADSBLOL-Budget': `${used}/${limit}`,
    'X-ADSBLOL-Keyed': keyed ? '1' : '0',
    ...(keyRefused ? { 'X-ADSBLOL-Key-Refused': '1' } : {}),
    ...(quota
      ? { 'X-ADSBLOL-Locked-Until': new Date(held.until).toISOString() }
      : {}),
  };
}

/** Write one adsb.lol disc as a flights answer. */
function writeAdsbLolPoint(
  req,
  res,
  fallback,
  { requestedMode, reason, coverage, adsbLol },
) {
  const encoded = encodedBody(req, fallback.body, fallback.gzip);
  const served = !['MISS', 'INFLIGHT'].includes(fallback.cacheStatus);
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus: fallback.cacheStatus,
      requestedMode,
      usedMode: 'adsblol-regional',
      reason,
    }),
    'X-Flight-Source': 'adsb.lol',
    'X-Flight-Coverage': coverage,
    'X-Flight-Count': String(fallback.count),
    'X-Flight-Privacy-Hidden': String(fallback.privacyHidden ?? 0),
    // Where the disc was read: a STALE one can be another place's.
    'X-Flight-Anchor': `${fallback.anchor.latitude.toFixed(2)},${fallback.anchor.longitude.toFixed(2)}`,
    // A disc from the cache says how old it is.
    ...(served
      ? {
          'X-Flight-Age-Seconds': String(
            Math.max(0, Math.round((Date.now() - fallback.cachedAt) / 1000)),
          ),
        }
      : {}),
    // A paced disc is asked again after this gap: it is not stale before.
    ...(fallback.cacheStatus === 'PACED' && Number.isFinite(fallback.gapMs)
      ? { 'X-ADSBLOL-Gap-Seconds': String(Math.ceil(fallback.gapMs / 1000)) }
      : {}),
    // Swedish fork: a whole view says how many of its discs it holds, and
    // keeps when the pace keeps fewer than it needs; how much of the view
    // they cover (100 only when nothing is left out or cut away) and whether
    // it was cut to the box around the look-at point; how often its centre
    // and outer discs are read, and whether the outer discs are held back;
    // how old the oldest disc but the centre's is; and how many aircraft
    // were kept of how many when it held more than the most it gives.
    ...(fallback.discs
      ? {
          'X-Flight-Discs': `${fallback.discs.shown}/${fallback.discs.total}`,
          ...(fallback.discs.kept < fallback.discs.total
            ? { 'X-Flight-Discs-Kept': String(fallback.discs.kept) }
            : {}),
          'X-Flight-View-Covered': String(fallback.view.covered),
          ...(fallback.view.clipped ? { 'X-Flight-View-Clipped': '1' } : {}),
          ...(fallback.outerHeld ? { 'X-Flight-Outer-Held': '1' } : {}),
          'X-Flight-Gap-Seconds': [
            fallback.pace.centreMs,
            ...(Number.isFinite(fallback.pace.outerMs)
              ? [fallback.pace.outerMs]
              : []),
          ]
            .map((ms) => Math.round(ms / 1000))
            .join('/'),
          ...(Number.isFinite(fallback.outerCachedAt)
            ? {
                'X-Flight-Outer-Age-Seconds': String(
                  Math.max(
                    0,
                    Math.round((Date.now() - fallback.outerCachedAt) / 1000),
                  ),
                ),
              }
            : {}),
          ...(fallback.seen > fallback.count
            ? { 'X-Flight-Capped': `${fallback.count}/${fallback.seen}` }
            : {}),
        }
      : {}),
    ...adsbLolBudgetHeaders(adsbLol),
    ...encoded.headers,
  });
  res.end(encoded.body);
}

/**
 * Serve the adsb.lol disc around the request's place in OpenSky mode, and
 * resolve whether one was. With `newerThanMs`, the epoch of the OpenSky frame
 * it would replace, a disc observed no later than that is not served: the
 * frame is the newer word.
 */
async function serveAdsbLolPointFallback(
  req,
  res,
  {
    requestedMode,
    reason,
    coverage = `${ADSBLOL_POINT_RADIUS_NM}nm regional fallback`,
    adsbLol,
    newerThanMs = null,
  },
) {
  const fallback = await fetchAdsbLolPointFallback(req, adsbLol);
  if (!fallback?.body) return false;
  if (
    Number.isFinite(newerThanMs) &&
    !((fallback.observedAtMs ?? fallback.cachedAt) > newerThanMs)
  )
    return false;
  writeAdsbLolPoint(req, res, fallback, {
    requestedMode,
    reason,
    coverage,
    adsbLol,
  });
  return true;
}

function openSkySourceEpochMs(body) {
  try {
    const seconds = Number(JSON.parse(body)?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return (
    Number.isFinite(sourceEpochMs) &&
    now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS
  );
}

/**
 * Vite plugin: OpenSky Network proxy with multi-mode auth and response caching.
 *
 * Supports four auth modes controlled by OPENSKY_AUTH_MODE env:
 *   - 'oauth'  (default) — client_credentials bearer token
 *   - 'basic'  — retired: OpenSky stopped accepting HTTP Basic (username and
 *                password) on 2026-03-18, so this requests anonymously and
 *                warns once
 *   - 'auto'   — try OAuth first, then anon
 *   - 'anon'   — no credentials
 *
 * Successful responses are cached for OPENSKY_CACHE_MS (~9 s). On
 * upstream failure the proxy serves a stale cached response if available, or
 * a bounded 250 nm adsb.lol point snapshot around the current view anchor.
 *
 * `adsbLol` is the adsb.lol transport every adsb.lol caller shares (see
 * adsbLolUpstream.js); without one the proxy keeps a transport of its own.
 *
 * @param {{adsbLol?: ReturnType<typeof createAdsbLolUpstream>}} [options]
 * @returns {import('vite').Plugin}
 */
export function openSkyProxy({ adsbLol = createAdsbLolUpstream() } = {}) {
  // Swedish fork: a stale OpenSky frame gives way only to a newer disc.
  const serveFallback = (req, res, requestedMode, reason, newerThanMs) =>
    serveAdsbLolPointFallback(req, res, {
      requestedMode,
      reason,
      adsbLol,
      newerThanMs,
    });
  const installMiddleware = (server) => {
    server.middlewares.use('/api/flights', async (req, res, next) => {
      try {
        // This mount also matches its /track route, served by its own handler.
        if (new URL(req.url || '/', 'http://localhost').pathname !== '/')
          return next();
        // After the /track hand-off, so /track keeps its own method handling.
        if (req.method !== 'GET') {
          res.writeHead(405, {
            'Content-Type': 'application/json',
            Allow: 'GET',
          });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }
        if (flightsFromAdsbLol()) {
          res.setHeader('X-Feed-Source', 'adsb.lol');
          // Swedish fork: a view larger than the disc gets its outer discs,
          // and its centre shares their pace.
          const plan = adsbLolViewPlan(req, adsbLol);
          const fallback = await fetchAdsbLolPointFallback(
            req,
            adsbLol,
            plan?.pace.centreMs,
          );
          if (fallback?.body) {
            const view = plan
              ? await wholeAdsbLolView(plan, fallback, adsbLol)
              : null;
            writeAdsbLolPoint(req, res, view ?? fallback, {
              requestedMode: 'off',
              reason: 'flights_source_adsblol',
              coverage: view
                ? `${ADSBLOL_VIEW_COVERAGE}, ${view.discs.shown} of ${view.discs.total} discs, ${view.view.covered === 100 ? 'the whole view' : `about ${view.view.covered}% of the view`}`
                : ADSBLOL_VIEW_COVERAGE,
              adsbLol,
            });
            return;
          }
          // No place yet (the first poll before the camera settles): nothing
          // to read around, and no other source is asked.
          if (fallback === null) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'X-Flight-Source': 'adsb.lol',
              'X-Flight-Coverage': ADSBLOL_VIEW_COVERAGE,
              ...adsbLolBudgetHeaders(adsbLol),
            });
            res.end(
              JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                states: [],
              }),
            );
            return;
          }
          // Nothing to serve. While the day's quota is spent the answer says
          // so and until when (Retry-After), so the layer does not ask
          // before then; a failure says when the next attempt is due.
          const { refusal } = fallback;
          const quota =
            refusal.reason === 'locked' || refusal.reason === 'budget';
          const waitMs = Math.max(0, refusal.retryAfterMs || 0);
          res.writeHead(quota ? 503 : 502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...adsbLolBudgetHeaders(adsbLol, refusal),
            'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))),
          });
          res.end(
            JSON.stringify(
              quota
                ? {
                    error: 'adsb.lol quota',
                    lockedUntil: new Date(refusal.until).toISOString(),
                  }
                : { error: 'adsb.lol unavailable' },
            ),
          );
          return;
        }
        res.setHeader('X-Feed-Source', 'OpenSky Network');
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        const now = Date.now();
        const inCooldown = now < _openskyCooldownUntil;
        // Fresh-enough cache (adaptive TTL) OR any cache during a 429
        // cooldown: serve it without touching upstream. Stale-during-cooldown
        // is deliberate (credit governor): last-good planes beat a dead layer.
        if (
          _openskyCacheBody &&
          (now - _openskyCacheTime < _openskyTtlMs || inCooldown)
        ) {
          if (
            openSkySourceIsStale(_openskyCacheSourceEpochMs, now) &&
            (await serveFallback(
              req,
              res,
              requestedMode,
              'opensky_snapshot_stale_regional_fallback',
              _openskyCacheSourceEpochMs,
            ))
          ) {
            return;
          }
          const cachedMeta = _openskyCacheMeta || {
            requestedMode,
            usedMode: 'unknown',
            reason: 'cached',
          };
          const isStale = now - _openskyCacheTime >= _openskyTtlMs;
          const encoded = encodedBody(
            req,
            _openskyCacheBody,
            _openskyCacheGzip,
          );
          res.writeHead(_openskyCacheStatus || 200, {
            ...buildOpenSkyHeaders({
              cacheStatus: isStale ? 'STALE' : 'HIT',
              requestedMode: cachedMeta.requestedMode || requestedMode,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: isStale
                ? _openskyCooldownStatus === 429
                  ? 'rate_limited_serving_stale'
                  : `upstream_http_${_openskyCooldownStatus}_serving_stale`
                : cachedMeta.reason || 'cached',
              staleSeconds: isStale
                ? (now - _openskyCacheTime) / 1000
                : undefined,
              retryAfterSeconds: inCooldown
                ? (_openskyCooldownUntil - now) / 1000
                : undefined,
            }),
            ...encoded.headers,
          });
          res.end(encoded.body);
          return;
        }
        // Cooling down with nothing cached (cold start into a rate limit):
        // synthesize the 429 locally — hammering upstream mid-cooldown can't
        // succeed and just burns goodwill.
        if (inCooldown) {
          if (
            await serveFallback(
              req,
              res,
              requestedMode,
              'opensky_cooldown_regional_fallback',
            )
          )
            return;
          res.writeHead(
            _openskyCooldownStatus,
            buildOpenSkyHeaders({
              cacheStatus: 'COOLDOWN',
              requestedMode,
              usedMode: 'none',
              reason:
                _openskyCooldownStatus === 429
                  ? 'rate_limited'
                  : `upstream_http_${_openskyCooldownStatus}`,
              retryAfterSeconds: (_openskyCooldownUntil - now) / 1000,
            }),
          );
          res.end(
            JSON.stringify({
              error: 'OpenSky upstream unavailable; proxy cooling down.',
            }),
          );
          return;
        }

        const refresh = coalesceProxyRequest(
          _openskySnapshotInFlight,
          'global',
          async () => {
            const headers = { Accept: 'application/json' };
            let usedMode = 'anon';
            let reason = 'forced_anonymous';

            if (requestedMode === 'basic') {
              // OpenSky no longer accepts a Basic header, so sending
              // OPENSKY_USERNAME / OPENSKY_PASSWORD would only fail; ask
              // anonymously and say once what to configure instead.
              if (!_openskyBasicRetiredWarned) {
                console.warn(
                  '[OpenSky] OPENSKY_AUTH_MODE=basic: OpenSky retired username/password sign-in on 2026-03-18, so flights load anonymously (rate-limited). Use OAuth client credentials: OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET, or OPENSKY_CREDENTIALS_FILE.',
                );
                _openskyBasicRetiredWarned = true;
              }
              reason = 'basic_retired';
            } else if (requestedMode === 'oauth') {
              const token = await getOpenSkyToken();
              if (token) {
                headers.Authorization = `Bearer ${token}`;
                usedMode = 'oauth';
                reason = 'oauth_token';
              } else {
                reason = 'oauth_invalid_or_missing';
              }
            } else if (requestedMode === 'auto') {
              const token = await getOpenSkyToken();
              if (token) {
                headers.Authorization = `Bearer ${token}`;
                usedMode = 'oauth';
                reason = 'oauth_token';
              } else {
                reason = 'missing_oauth_creds';
              }
            }

            const { upstream, body } = await fetchOpenSkyStates(headers);

            const sourceEpochMs = upstream.ok
              ? openSkySourceEpochMs(body)
              : null;
            // Refine the reason string to reflect the actual outcome
            if (upstream.ok && reason === 'forced_anonymous') {
              reason = 'anonymous_ok';
            } else if (
              upstream.ok &&
              usedMode === 'oauth' &&
              reason === 'oauth_token'
            ) {
              reason = 'oauth_ok';
            }

            // Only cache successful responses — error responses (401/403/429/5xx)
            // should not be served from cache on subsequent requests
            if (upstream.ok) {
              // Compress before writing either slot, so a request arriving
              // mid-refresh still reads a body with its own frame.
              const frame = await gzipBody(body);
              _openskyCacheBody = body;
              _openskyCacheGzip = frame;
              _openskyCacheStatus = upstream.status;
              _openskyCacheTime = now;
              _openskyCacheSourceEpochMs = sourceEpochMs;
              _openskyCacheMeta = {
                requestedMode,
                usedMode,
                reason,
              };
              // Credit governor: adapt the cache TTL to the remaining daily
              // budget so a continuously-open app stretches its polls instead of
              // exhausting the quota mid-day. Success also clears any cooldown.
              const remaining = Number(
                upstream.headers.get('x-rate-limit-remaining'),
              );
              _openskyTtlMs = openskyAdaptiveTtlMs(remaining);
              _openskyCooldownUntil = 0;
            }

            return {
              upstream,
              body,
              usedMode,
              reason,
              sourceEpochMs,
            };
          },
        );
        let { upstream, body, usedMode, reason, sourceEpochMs } =
          await refresh.promise;
        if (
          upstream.ok &&
          openSkySourceIsStale(sourceEpochMs, now) &&
          (await serveFallback(
            req,
            res,
            requestedMode,
            'opensky_snapshot_stale_regional_fallback',
            sourceEpochMs,
          ))
        ) {
          return;
        }
        if (upstream.status === 429 || upstream.status >= 500) {
          reason =
            upstream.status === 429
              ? 'rate_limited'
              : `upstream_http_${upstream.status}`;
          // Credit governor: fetchOpenSkyStates already started the cooldown
          // from OpenSky's retry-after — no upstream attempts until then.
          const cooldownMs = Math.max(0, _openskyCooldownUntil - Date.now());
          // Serve the last-good body instead of the 429 when we have one —
          // the layer keeps rendering (STALE-cued) instead of dying.
          if (_openskyCacheBody && _openskyCacheStatus === 200) {
            const encoded = encodedBody(
              req,
              _openskyCacheBody,
              _openskyCacheGzip,
            );
            res.writeHead(200, {
              ...buildOpenSkyHeaders({
                cacheStatus: 'STALE',
                requestedMode,
                usedMode,
                reason: `${reason}_serving_stale`,
                staleSeconds: (now - _openskyCacheTime) / 1000,
                retryAfterSeconds: cooldownMs / 1000,
              }),
              ...encoded.headers,
            });
            res.end(encoded.body);
            return;
          }
        }

        if (!upstream.ok && !_openskyCacheBody) {
          const servedFallback = await serveFallback(
            req,
            res,
            requestedMode,
            `opensky_http_${upstream.status}_regional_fallback`,
          );
          if (servedFallback) return;
        }

        if (upstream.status === 401 || upstream.status === 403) {
          if (requestedMode === 'oauth' && usedMode !== 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET, or OPENSKY_CREDENTIALS_FILE.',
            });
            reason = 'oauth_invalid_or_missing';
          } else if (usedMode === 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth client credentials were rejected.',
            });
            reason = 'oauth_invalid_credentials';
          } else if (requestedMode === 'auto') {
            body = JSON.stringify({
              error:
                'OpenSky auth missing. Provide OAuth client credentials: OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET, or OPENSKY_CREDENTIALS_FILE.',
            });
            reason = 'missing_oauth_creds';
          } else {
            body = JSON.stringify({
              error: 'OpenSky auth required.',
            });
            reason = 'auth_required';
          }
        }

        // The frame belongs to this body only if this body was cached. An
        // uncached error must not borrow the previous snapshot's frame.
        const encoded = encodedBody(
          req,
          body,
          _openskyCacheBody === body ? _openskyCacheGzip : null,
        );
        res.writeHead(upstream.status, {
          ...buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode,
            reason,
          }),
          ...encoded.headers,
        });
        res.end(encoded.body);
      } catch (e) {
        console.error('[OpenSky Proxy]', e.message);
        if (_openskyCacheBody) {
          const cachedMeta = _openskyCacheMeta || {
            requestedMode: normalizeOpenSkyAuthMode(
              process.env.OPENSKY_AUTH_MODE,
            ),
            usedMode: 'unknown',
            reason: 'cached_stale',
          };
          const encoded = encodedBody(
            req,
            _openskyCacheBody,
            _openskyCacheGzip,
          );
          res.writeHead(_openskyCacheStatus || 200, {
            ...buildOpenSkyHeaders({
              cacheStatus: 'STALE',
              requestedMode:
                cachedMeta.requestedMode || OPENSKY_AUTH_MODE_DEFAULT,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: cachedMeta.reason || 'cached_stale',
            }),
            ...encoded.headers,
          });
          res.end(encoded.body);
          return;
        }
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        if (
          await serveFallback(
            req,
            res,
            requestedMode,
            'opensky_proxy_error_regional_fallback',
          )
        )
          return;
        res.writeHead(
          502,
          buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode: 'error',
            reason: 'proxy_error',
          }),
        );
        res.end(JSON.stringify({ error: 'OpenSky proxy error' }));
      }
    });
  };
  return {
    name: 'opensky-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
