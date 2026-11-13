import {
  normalizeCrisisItems,
  createCountyLookup,
} from '../../src/layers/smhiWarnings/crisis.js';
import { createPlaceLookup } from '../../src/layers/policeEvents/records.js';
import { SWEDISH_MUNICIPALITIES } from './polisen/municipalities.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  createKrisinformationFeed,
  createSmhiWarningsFeed,
  sharedKrisinformationFeed,
  sharedSmhiWarningsFeed,
} from './swedishAlertFeeds.js';
export { SMHI_WARNINGS_URL } from './swedishAlertFeeds.js';

// SMHI's impact-based weather warnings (CC BY 4.0) and Krisinformation.se's
// VMAs and recent crisis news (MCF, no key), so everything serious sits in
// one layer. Both come from the server's shared readers
// (swedishAlertFeeds.js), which the VMA banner, the city dossier and the
// cockpit briefing read too.
const crisisLookups = {
  places: createPlaceLookup(SWEDISH_MUNICIPALITIES),
  counties: createCountyLookup(SWEDISH_MUNICIPALITIES),
};
const TTL_MS = 5 * 60_000;
/** How long SMHI is left alone after a failed refresh. */
export const SMHI_WARNINGS_RETRY_AFTER_FAILURE_MS = 60_000;
/**
 * Longest a failed refresh keeps serving the last snapshot, marked stale, and
 * longest the last crisis list is kept while Krisinformation fails.
 */
const STALE_MAX_MS = 60 * 60_000;

/** Bounded SMHI warning route for dev and preview. */
export function smhiWarningsProxy({
  fetchImpl,
  now = () => Date.now(),
  warningsFeed,
  crisisFeed,
} = {}) {
  // Readers of their own only when a test hands in a fetch.
  warningsFeed ??= fetchImpl
    ? createSmhiWarningsFeed({ fetchImpl, now })
    : sharedSmhiWarningsFeed();
  crisisFeed ??= fetchImpl
    ? createKrisinformationFeed({ fetchImpl, now })
    : sharedKrisinformationFeed();
  let cached = null;
  let retryAfter = 0;
  /** The last crisis list Krisinformation answered with: {items, savedAt}. */
  let lastCrisis = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function load() {
    const [warnings, crisis] = await Promise.allSettled([
      warningsFeed.read(),
      crisisFeed.read(),
    ]);
    // A warning list that can no longer be confirmed is a failed refresh.
    if (warnings.status === 'rejected') throw warnings.reason;
    if (!warnings.value.fresh) throw new Error('SMHI warnings unavailable');
    const fetchedAt = now();
    // Crisis messages are an addition: when Krisinformation fails, the
    // warnings still serve and the last crisis list is kept, for an hour:
    // a VMA that has ended must not stay on the map.
    const crisisOk = crisis.status === 'fulfilled' && crisis.value.fresh;
    if (!crisisOk)
      console.warn(
        `[smhi-warnings] krisinformation failed: ${
          crisis.reason?.message || 'serving the last list'
        }`,
      );
    if (
      crisis.status === 'fulfilled' &&
      crisis.value.savedAt !== lastCrisis?.savedAt
    )
      lastCrisis = {
        items: normalizeCrisisItems(
          { vmas: crisis.value.vmas, news: crisis.value.news },
          crisisLookups,
          fetchedAt,
        ),
        savedAt: crisis.value.savedAt,
      };
    return {
      ...warnings.value.warnings,
      crisis:
        lastCrisis && fetchedAt - lastCrisis.savedAt <= STALE_MAX_MS
          ? lastCrisis.items
          : [],
      crisisStale: !crisisOk,
      // When SMHI was read: the shared reader may have read it for another
      // part a few minutes ago, and the cache below counts from then.
      fetchedAt: warnings.value.savedAt,
    };
  }

  /** The last snapshot marked stale, or null once it is too old to show. */
  const lastKnown = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  /**
   * One read of SMHI and Krisinformation, shared by everyone waiting on it:
   * the new snapshot, or after a failure the last one (null without one).
   */
  async function refresh() {
    try {
      const value = await load();
      cached = { value, savedAt: value.fetchedAt };
      retryAfter = 0;
      console.log(
        `[smhi-warnings] ${value.areas.length} warning areas, ${value.crisis.length} crisis messages`,
      );
      return value;
    } catch (error) {
      console.warn(
        `[smhi-warnings] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + SMHI_WARNINGS_RETRY_AFTER_FAILURE_MS;
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
        : await coalesceProxyRequest(inFlight, 'warnings', refresh).promise;
    if (!value) return json(502, { error: 'smhi_warnings_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
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
