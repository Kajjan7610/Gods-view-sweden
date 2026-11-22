import {
  coalesceProxyRequest,
  readResponseTextCapped,
} from '../common/http.js';
import { visibleAdsbLolAircraft } from '../../../src/data/adsbLolFallback.js';
import { createAdsbLolUpstream } from './adsbLolUpstream.js';

/** The /v2/mil answer without aircraft whose owners asked not to be shown. */
function withoutHiddenAircraft(body) {
  try {
    const payload = JSON.parse(body);
    if (!Array.isArray(payload?.ac)) return body;
    return JSON.stringify({
      ...payload,
      ac: visibleAdsbLolAircraft(payload.ac),
    });
  } catch {
    return body;
  }
}

/**
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Serves GET /api/military from https://api.adsb.lol/v2/mil. When upstream
 * fails — a thrown fetch OR a non-OK status such as 429 — the proxy serves its
 * cached body as STALE instead of relaying the failure. Swedish fork: the
 * call goes through the adsb.lol transport every adsb.lol caller shares
 * (adsbLolUpstream.js), which keeps the backoff: a 429 locks every adsb.lol
 * path for its Retry-After, any other failure holds this route back (60 s,
 * doubling in a row), and /v2/mil, lowest priority, draws on the flights'
 * part of the daily budget and stops once half of it is used. A failure with
 * nothing cached is answered with its status.
 *
 * Why the non-OK case matters: the browser layer treats a relayed 429 as a
 * 45 s cooldown during which EVERY refresh (the 15 s poll and any tracking
 * resolve) reports "adsb.lol rate limited", which the global status chip
 * renders as LOAD FAILED while the map is still fully populated.
 *
 * @param {{adsbLol?: ReturnType<typeof createAdsbLolUpstream>}} [options]
 *   The shared transport; without one the proxy keeps its own.
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy({ adsbLol = createAdsbLolUpstream() } = {}) {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  const inFlight = new Map();
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  /** Upstream deadline (ms); the fetch previously had none and could hang a poll. */
  const UPSTREAM_TIMEOUT_MS = 12000;
  /** /v2/mil measures ~67 KB; a relayed error page is bounded by the same cap. */
  const ADSBLOL_MIL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  /** Whole seconds of a wait, at least one. */
  const seconds = (ms) => String(Math.max(1, Math.ceil(ms / 1000)));

  function serve(res, status, body, cacheStatus, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': 'adsb.lol',
      'X-Feed-Cache': cacheStatus,
      ...(['HIT', 'STALE'].includes(cacheStatus)
        ? {
            'X-Feed-Age-Ms': String(Math.max(0, Date.now() - _cacheAt)),
          }
        : {}),
      ...extra,
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/military', async (req, res, next) => {
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
        const now = Date.now();
        if (_cache && now - _cacheAt < CACHE_MS) {
          serve(res, 200, _cache, 'HIT');
          return;
        }
        // Locked out, past this route's share of the day's budget, or held
        // back after a failure: no upstream call until then. A call already
        // on its way is joined first: it is spent already.
        const held = inFlight.has('global') ? null : adsbLol.admit('mil', now);
        if (held) {
          const retryAfter = seconds(held.retryAfterMs);
          if (_cache) {
            serve(res, 200, _cache, 'STALE', {
              'X-ADS-B-Upstream-Status': String(held.status),
              'X-ADS-B-Retry-After-Seconds': retryAfter,
            });
            return;
          }
          serve(
            res,
            held.status || 503,
            JSON.stringify({ error: 'adsb.lol upstream cooling down' }),
            'NONE',
            { 'Retry-After': retryAfter },
          );
          return;
        }
        const refresh = coalesceProxyRequest(inFlight, 'global', async () => {
          const result = (status, body, cacheStatus, extra = {}) => ({
            status,
            body,
            cacheStatus,
            extra,
          });
          let body;
          try {
            body = await adsbLol.request('mil', '/v2/mil', {
              userAgent: 'gods-eye-view-adsblol-proxy/1.0',
              timeoutMs: UPSTREAM_TIMEOUT_MS,
              read: (upstream, signal) =>
                readResponseTextCapped(
                  upstream,
                  ADSBLOL_MIL_MAX_RESPONSE_BYTES,
                  signal,
                ),
            });
          } catch (error) {
            // Any other failure is answered from the cache below.
            if (error?.name !== 'AdsbLolRefusal') throw error;
            const waiting = error.retryAfterMs > 0;
            console.warn(
              `[adsb.lol Proxy] ${error.message} (${error.status})${waiting ? `; cooling down ${seconds(error.retryAfterMs)} s` : ''}${_cache ? ', serving stale' : ''}`,
            );
            if (_cache)
              return result(200, _cache, 'STALE', {
                'X-ADS-B-Upstream-Status': String(error.status),
                ...(waiting
                  ? {
                      'X-ADS-B-Retry-After-Seconds': seconds(
                        error.retryAfterMs,
                      ),
                    }
                  : {}),
              });
            // The refused body was dropped unread; say what happened.
            return result(
              error.status || 502,
              JSON.stringify({ error: 'adsb.lol upstream unavailable' }),
              'MISS',
              waiting ? { 'Retry-After': seconds(error.retryAfterMs) } : {},
            );
          }
          const visible = withoutHiddenAircraft(body);
          _cache = visible;
          _cacheAt = Date.now();
          return result(200, visible, 'MISS');
        });
        const response = await refresh.promise;
        serve(
          res,
          response.status,
          response.body,
          response.cacheStatus,
          response.extra,
        );
      } catch (e) {
        console.error('[adsb.lol Proxy]', e.message);
        if (_cache) {
          serve(res, 200, _cache, 'STALE');
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
      }
    });
  };
  return {
    name: 'adsblol-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
