import path from 'node:path';
import { providerCooldownMs } from './cooldown.js';
import { promises as fsp } from 'node:fs';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../common/http.js';
import { launchLibraryRecentUrl } from '../../../src/data/spaceProviderRequests.js';

export const LL2_CACHE_TTL_MS = 15 * 60_000;

/**
 * Swedish fork: the shortest wait after a failed refresh. Without a token
 * Launch Library allows 15 calls an hour, one every four minutes.
 */
export const LL2_FAILURE_WAIT_MS = 4 * 60_000;

/**
 * Swedish fork: the longest Retry-After honoured. A throttled feed names the
 * wait until its hourly allowance renews, up to an hour.
 */
export const LL2_RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * Swedish fork: a Launch Library 2 response cut, by an allow-list, to the
 * fields the app reads, before it is cached or forwarded: those the Space
 * Missions normaliser reads (src/layers/launches/model.js) and those the
 * voice tool get_recent_launches reads (src/tools/queries/space.js).
 * Everything else is dropped, among it the update notes with their
 * contributors' names and photos, agency details such as administrators,
 * image credits, video and info links, and crew records: no field the app
 * reads is a person's record. A field read as a value keeps only a text,
 * number, boolean or null; a launch, stage or payload that is not an object
 * is dropped.
 * @param {{results: Array<unknown>}} parsed A parsed upstream response.
 * @returns {{results: Array<object>}}
 */
export function launchLibraryAppBody(parsed) {
  const leaf = true;
  const named = { name: leaf };
  // A text, or an object read for its name.
  const nameOrNamed = (value) =>
    typeof value === 'string' ? value : pick(value, named);
  const landing = {
    id: leaf,
    attempt: leaf,
    success: leaf,
    type: named,
    destination: leaf,
    description: leaf,
    downrange_distance: leaf,
    latitude: leaf,
    longitude: leaf,
    landing_location: { name: leaf, latitude: leaf, longitude: leaf },
  };
  const vehicle = { serial_number: leaf, status: named };
  const stage = {
    id: leaf,
    type: nameOrNamed,
    serial_number: leaf,
    reused: leaf,
    launcher_flight_number: leaf,
    landing,
    launcher: vehicle,
    spacecraft: vehicle,
  };
  const payload = {
    id: leaf,
    name: leaf,
    type: named,
    manufacturer: named,
    operator: named,
    destination: leaf,
    mass: leaf,
  };
  // A payload flight, or a payload listed on its own; a flight with a
  // landing is read as a recovery stage too.
  const flight = {
    ...payload,
    amount: leaf,
    payload,
    landing,
    reused: leaf,
    launcher_flight_number: leaf,
    launcher: vehicle,
    spacecraft: vehicle,
  };
  const launch = {
    id: leaf,
    slug: leaf,
    name: leaf,
    net: leaf,
    window_start: leaf,
    status: named,
    launch_service_provider: named,
    pad: {
      name: leaf,
      latitude: leaf,
      longitude: leaf,
      location: { name: leaf, coordinates: leaf },
    },
    mission: {
      name: leaf,
      description: leaf,
      orbit: nameOrNamed,
      payloads: [flight],
    },
    rocket: {
      configuration: { name: leaf, full_name: leaf },
      payloads: [flight],
      launcher_stage: [stage],
      spacecraft_stage: [stage],
    },
    payloads: [flight],
    orbit: nameOrNamed,
    timeline: [
      {
        name: leaf,
        relative_time: leaf,
        relativeTime: leaf,
        type: { name: leaf, abbrev: leaf },
      },
    ],
    trajectory: [
      {
        latitude: leaf,
        longitude: leaf,
        altitude: leaf,
        stage: leaf,
        stage_name: leaf,
        phase: leaf,
        stageName: leaf,
      },
    ],
  };
  function pick(value, shape) {
    if (shape === leaf)
      return value === null ||
        ['string', 'number', 'boolean'].includes(typeof value)
        ? value
        : undefined;
    if (typeof shape === 'function') return shape(value);
    if (Array.isArray(shape))
      return Array.isArray(value)
        ? value
            .map((item) => pick(item, shape[0]))
            .filter((item) => item !== undefined)
        : undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return undefined;
    const kept = {};
    for (const [key, inner] of Object.entries(shape)) {
      if (!Object.hasOwn(value, key)) continue;
      const field = pick(value[key], inner);
      if (field !== undefined) kept[key] = field;
    }
    return kept;
  }
  return {
    results: parsed.results
      .map((entry) => pick(entry, launch))
      .filter((entry) => entry !== undefined),
  };
}

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    'User-Agent':
      'gods-eye-view-launch-library-proxy/1.0 (+https://github.com/Kajjan7610/Gods-view-sweden)',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

/** Proxy the public Launch Library 2 recent-launch feed server-side. */
export function rocketLaunchesProxy() {
  const ttlMs = LL2_CACHE_TTL_MS;
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'launch-library-2-v2.3.json',
  );
  let cache = null;
  let cooldownUntil = 0;
  let cooldownStatus = 502;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes)
        throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) {
          // Swedish fork: a cache an earlier version wrote holds the whole
          // feed; it is cut to the app's fields, and so is the file.
          const trimmed = JSON.stringify(launchLibraryAppBody(body));
          cache = { at: parsed.at, body: trimmed };
          if (trimmed !== parsed.body) await saveDiskCache(cache);
        }
      }
    } catch {
      /* first run or invalid cache */
    }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn('[launch-library-proxy] cache write failed');
    }
  }

  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control':
        status === 200 && cacheState !== 'STALE-ERROR'
          ? 'public, max-age=900'
          : 'no-store',
      ...(cache ? { 'X-GEV-Cached-At': new Date(cache.at).toISOString() } : {}),
      ...(Date.now() < cooldownUntil
        ? {
            'Retry-After': String(
              Math.ceil((cooldownUntil - Date.now()) / 1000),
            ),
          }
        : {}),
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const end = new Date();
    const url = launchLibraryRecentUrl(end);
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    if (!upstream.ok) {
      // Swedish fork: at least LL2_FAILURE_WAIT_MS, and a Retry-After up to
      // LL2_RETRY_AFTER_MAX_MS.
      const deadline =
        Date.now() +
        Math.max(
          LL2_FAILURE_WAIT_MS,
          providerCooldownMs(upstream, Date.now(), LL2_RETRY_AFTER_MAX_MS),
        );
      // Never shorten a longer cooldown that is already in force.
      if (deadline >= cooldownUntil) {
        cooldownUntil = deadline;
        cooldownStatus = upstream.status;
      }
      void upstream.body?.cancel().catch(() => {});
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results))
      throw new Error('malformed upstream response');
    // Swedish fork: only the fields the app reads are cached and forwarded.
    const fresh = {
      at: Date.now(),
      body: JSON.stringify(launchLibraryAppBody(parsed)),
    };
    cache = fresh;
    cooldownUntil = 0;
    void saveDiskCache(fresh);
    return fresh;
  }

  function install(middlewares) {
    middlewares.use('/api/launches', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
        return;
      }
      await loadDiskCache();
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) {
        send(res, 200, cache.body, 'HIT');
        return;
      }
      const stale = cache;
      if (now < cooldownUntil) {
        send(
          res,
          stale ? 200 : cooldownStatus,
          stale?.body ||
            JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          stale ? 'STALE-ERROR' : 'NONE',
        );
        return;
      }
      const request = coalesceProxyRequest(
        inFlight,
        'recent-launches',
        refreshUpstream,
      );
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        if (Date.now() >= cooldownUntil) {
          // Swedish fork: a failure with no answer waits as long.
          cooldownUntil = Date.now() + LL2_FAILURE_WAIT_MS;
          cooldownStatus = 502;
        }
        // Log only a bounded status, never upstream bodies, URLs, or credentials.
        const status = Number.isInteger(error?.upstreamStatus)
          ? error.upstreamStatus
          : 502;
        if (!request.shared)
          console.warn(
            `[launch-library-proxy] refresh failed (HTTP ${status})${stale ? ' — serving stale cache' : ''}`,
          );
        if (stale) {
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          status,
          JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'rocket-launches-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
