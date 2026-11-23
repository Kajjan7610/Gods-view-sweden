import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakGpUrl,
  celestrakSatcatUrl,
} from '../../../src/data/spaceProviderRequests.js';
import { createCelestrakUpstream } from './celestrakUpstream.js';
import { admitSameSiteKeyless } from '../common/same-site.js';

/**
 * The fields a GP row needs to become an orbit, the ones src/sources/gp.js
 * reads (its GP_REQUIRED_FIELDS; a test holds the two lists equal): a body
 * whose header lacks one is not usable.
 */
export const CELESTRAK_GP_FIELDS = Object.freeze([
  'OBJECT_NAME',
  'NORAD_CAT_ID',
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
]);

/**
 * Vite plugin: CelesTrak GP proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite GP data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=CSV
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (stale elements
 * beat an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * Swedish fork: GP data comes as CSV (src/sources/gp.js parses it), which,
 * unlike the TLE format, carries objects numbered 100000 and up. Its cache
 * files are new (`celestrak-gp-csv-<group>.json`); the TLE ones are no
 * longer read, so no group is ever asked for in both formats.
 *
 * The same plugin serves CelesTrak SATCAT records for the satellites layer's
 * groups at `/api/celestrak-satcat/<group>` (object type, operational status
 * and owner, which file each object under a class). The catalog changes
 * slowly, so SATCAT is cached for a day.
 *
 * Swedish fork: every call to CelesTrak goes through `upstream`
 * (celestrakUpstream.js), which follows CelesTrak's usage policy: one call
 * at a time, any failure pausing both routes, a 404's URL left out and each
 * URL asked at most once in 2 h. While a pause keeps a group from being
 * refreshed, its last copy is served whatever its age (502 without one),
 * with `Retry-After` and `X-CelesTrak-Held-Until`; a group CelesTrak
 * answered 404 for is marked `X-CelesTrak-Gone: 404`. A refresh that waits
 * its turn behind other calls is answered from the last copy at once
 * (`STALE`) and lands in the cache for the next poll. The composition passes
 * the shared transport (server/providers/local.js); without one, a factory
 * call makes its own.
 *
 * @param {{upstream?: ReturnType<typeof createCelestrakUpstream>}} [options]
 */
export function celestrakProxy({ upstream = createCelestrakUpstream() } = {}) {
  const TLE_TTL_MS = 6 * 3600_000;
  const SATCAT_TTL_MS = 24 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  /** The satellites layer's core groups (src/layers/satellites/policy.js). */
  const coreGroups = [
    'stations',
    'visual',
    'gps-ops',
    'glo-ops',
    'galileo',
    'geo',
    'resource',
    'weather',
    'planet',
    'sar',
    'science',
  ];
  /** Whether a body is GP CSV: those fields on its first line, a row under it. */
  const isGpCsv = (body) => {
    const end = body.indexOf('\n');
    if (end < 0) return false;
    // trim() also drops a byte order mark before the first name.
    const header = body
      .slice(0, end)
      .split(',')
      .map((name) => name.trim().replace(/^"(.*)"$/, '$1'));
    return (
      CELESTRAK_GP_FIELDS.every((name) => header.includes(name)) &&
      /\S/.test(body.slice(end + 1))
    );
  };
  const feeds = [
    {
      route: '/api/celestrak',
      ttlMs: TLE_TTL_MS,
      cacheHeader: 'x-tle-cache',
      cachedAtHeader: 'X-TLE-Cached-At',
      diskName: (group) => `celestrak-gp-csv-${group}.json`,
      upstreamUrl: celestrakGpUrl,
      // The layer cannot do without its elements: they go first in the queue.
      priority: 0,
      label: 'GP group',
      groups: new Set([
        ...coreGroups,
        'starlink',
        // Space Missions (`getActiveTle`) reads the full active catalog.
        'active',
      ]),
      // An upstream error page or an empty answer has no GP rows — treat as
      // failure, keep cache.
      validate: isGpCsv,
      invalid: 'no GP CSV rows in response',
    },
    {
      route: '/api/celestrak-satcat',
      ttlMs: SATCAT_TTL_MS,
      cacheHeader: 'x-satcat-cache',
      cachedAtHeader: 'X-SATCAT-Cached-At',
      diskName: (group) => `celestrak-satcat-${group}.json`,
      upstreamUrl: celestrakSatcatUrl,
      // SATCAT only refines the classes.
      priority: 1,
      label: 'SATCAT group',
      groups: new Set(coreGroups),
      // A real answer, even for an empty group, starts with the CSV header.
      validate: (body) => /^OBJECT_NAME,/.test(body),
      invalid: 'no SATCAT header in response',
    },
  ];

  /**
   * The largest group (`active`) measured ~2.7 MB as TLE; a CSV row is a
   * little shorter than an object's three TLE lines. This bounds a runaway
   * body.
   */
  const CELESTRAK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

  function createFeedHandler(feed) {
    const mem = new Map(); // group -> { at: epochMs, body: string }
    const inflight = new Map(); // group -> Promise<{at, body}|null>
    const diskPath = (group) => path.join(CACHE_DIR, feed.diskName(group));

    async function readDisk(group) {
      try {
        const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
        if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
          return parsed;
      } catch {
        /* no disk cache yet */
      }
      return null;
    }

    async function writeDisk(group, entry) {
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
      } catch (err) {
        console.warn('[celestrak-proxy] cache write failed');
      }
    }

    return async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      // Keyless and needed to render the satellites layer: refuse cross-site
      // browsers but keep the documented reverse-proxy deployment working.
      if (admitSameSiteKeyless(req, res)) return;
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!feed.groups.has(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      /** `held` is why the group was not refreshed (upstream.admit). */
      const send = (status, body, cacheStatus, entry, held = null) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        // A pause with an end; a 404's URL has none.
        const until = Number.isFinite(held?.until) ? held.until : 0;
        const at = until ? Date.now() : 0;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          [feed.cacheHeader]: cacheStatus,
          'Cache-Control': 'no-store',
          ...(entry
            ? { [feed.cachedAtHeader]: new Date(entry.at).toISOString() }
            : {}),
          ...(until > at
            ? {
                'Retry-After': String(Math.ceil((until - at) / 1000)),
                'X-CelesTrak-Held-Until': new Date(until).toISOString(),
              }
            : {}),
          // CelesTrak answered 404 for it: the proxy no longer asks.
          ...(held?.reason === 'gone'
            ? { 'X-CelesTrak-Gone': String(held.status) }
            : {}),
        });
        res.end(body);
      };
      /** The last copy, whatever its age (stale beats empty), else 502. */
      const sendLast = (entry, held) => {
        if (entry) send(200, entry.body, 'STALE-ERROR', entry, held);
        else
          send(
            502,
            Number.isFinite(held?.until)
              ? 'celestrak upstream cooling down'
              : 'celestrak fetch failed and no cache available',
            'NONE',
            null,
            held,
          );
      };
      try {
        const now = Date.now();
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        }
        if (entry && now - entry.at < feed.ttlMs) {
          send(200, entry.body, 'HIT', entry);
          return;
        }
        const url = feed.upstreamUrl(group).toString();
        // Stale or missing → refresh, single-flight per group (and per URL in
        // the transport, which checks the pause again right before the call
        // goes out); while CelesTrak is not to be asked, the last copy.
        if (!inflight.has(group)) {
          const held = upstream.admit(url);
          if (held) {
            sendLast(entry, held);
            return;
          }
          inflight.set(
            group,
            upstream
              .request(url, {
                label: `${feed.label} ${group}`,
                priority: feed.priority,
                validate: feed.validate,
                invalid: feed.invalid,
                maxBytes: CELESTRAK_MAX_RESPONSE_BYTES,
              })
              .then(async (fresh) => {
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                return fresh;
              })
              // The transport has said why, once; the cache answers.
              .catch(() => null)
              .finally(() => inflight.delete(group)),
          );
        }
        // Swedish fork: a refresh waiting its turn behind other CelesTrak
        // calls does not hold the browser's connection. The last copy answers
        // now; the refresh lands in the cache for the next poll.
        if (entry && upstream.waiting(url)) {
          send(200, entry.body, 'STALE', entry);
          return;
        }
        const fresh = await inflight.get(group);
        if (fresh) send(200, fresh.body, 'MISS', fresh);
        else sendLast(entry, upstream.admit(url)); // upstream down — stale beats empty
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    };
  }

  const handlers = feeds.map((feed) => [feed.route, createFeedHandler(feed)]);
  const installMiddleware = (server) => {
    for (const [route, handler] of handlers)
      server.middlewares.use(route, handler);
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
