import {
  finite,
  httpError,
  LiveSourceError,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';
import { parsePlanespottersPhoto } from '../../data/planespottersPhoto.js';
import {
  MMSI,
  openVesselPhotosUrl,
  parseOpenVesselPhoto,
} from '../../data/openVesselPhoto.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

/** Planespotters' public photo lookup, called straight from the browser (it
 *  answers with `access-control-allow-origin: *`). */
const PLANESPOTTERS_PHOTOS = 'https://api.planespotters.net/pub/photos/hex/';
/** A photo is decoration: a slow answer gives up rather than hold an
 *  enrichment slot. */
const PHOTO_TIMEOUT_MS = 8000;

/** The tracked plane's Planespotters photo, read and host-checked. */
async function planespottersPhoto(fetchImpl, hex, signal) {
  const id = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(id))
    throw new LiveSourceError('unsupported', 'Enrichment unavailable');
  const timeout = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
  const { response, payload } = await readResponse(
    fetchImpl,
    PLANESPOTTERS_PHOTOS + id,
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: 'omit',
    },
    'Planespotters',
  );
  if (!response.ok) throw httpError(response, 'Planespotters');
  return parsePlanespottersPhoto(payload);
}

/**
 * A vessel's Open Vessel Photos photo, read and host-checked. The API is
 * keyless and answers with `access-control-allow-origin: *`, so the browser
 * asks it straight. An MMSI it does not know answers 404: no photo.
 * @param {Function} fetchImpl fetch.
 * @param {string} mmsi The vessel's nine-digit MMSI.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<object>} A `parseOpenVesselPhoto` result.
 */
export async function fetchOpenVesselPhoto(fetchImpl, mmsi, signal) {
  const id = String(mmsi || '');
  if (!MMSI.test(id))
    throw new LiveSourceError('unsupported', 'Enrichment unavailable');
  const timeout = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
  const { response, payload } = await readResponse(
    fetchImpl,
    openVesselPhotosUrl(id),
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: 'omit',
    },
    'Open Vessel Photos',
  );
  if (response.status === 404) return parseOpenVesselPhoto(null);
  if (!response.ok) throw httpError(response, 'Open Vessel Photos');
  return parseOpenVesselPhoto(payload, id);
}

function openSkyError(response, nowMs) {
  const error = httpError(response, 'Flights', {
    honourRetryAfter: true,
    now: nowMs,
  });
  const mode = String(
    header(response, 'x-opensky-auth-mode-used') ||
      header(response, 'x-opensky-auth') ||
      '',
  ).toLowerCase();
  const reason = String(
    header(response, 'x-opensky-auth-reason') || '',
  ).toLowerCase();
  if (response.status === 429 && (!mode || mode === 'anon'))
    error.message = 'OpenSky rate limited (anonymous)';
  if (response.status === 401 || response.status === 403) {
    const reasons = {
      oauth_invalid_or_missing: 'OpenSky OAuth client missing/invalid',
      oauth_invalid_credentials: 'OpenSky OAuth rejected credentials',
      missing_oauth_creds: 'OpenSky auth missing',
      auth_required: 'OpenSky auth required',
      forced_anonymous: 'OpenSky auth required',
    };
    error.message =
      reasons[reason] ||
      (/^(oauth_|basic_)/.test(reason)
        ? 'OpenSky auth invalid'
        : mode === 'anon'
          ? 'OpenSky auth required'
          : 'OpenSky auth failed');
  }
  return error;
}

/**
 * The provider a feed response names in `X-Feed-Source`, so a server that
 * answers a feed route from another provider is reported as that provider.
 */
function feedSource(response, fallback) {
  const named = header(response, 'x-feed-source');
  return typeof named === 'string' && named.trim()
    ? named.trim().slice(0, 80)
    : fallback;
}

/**
 * What the server says of adsb.lol's daily quota with a flights answer
 * (Swedish fork, server/providers/aircraft/adsbLolUpstream.js), or null
 * without word of it: calls `used` of the `limit`, whether calls go with a
 * key, whether adsb.lol refused the key set (`keyRefused`), until when no
 * call may be sent (`lockedUntil`, epoch ms), how the disc was served
 * (`cache`: MISS, HIT, PACED, STALE …), a paced disc's gap (`gapMs`), where
 * it was read (`anchor`, from X-Flight-Anchor) and the point asked about
 * (`asked`). A whole view adds how many of its discs it holds of how many
 * it needs and keeps up to date (`discs`, from X-Flight-Discs and
 * X-Flight-Discs-Kept), how often its centre and outer discs are read
 * (`gaps`, from X-Flight-Gap-Seconds; `outerMs` null with none kept),
 * whether the outer discs are held back just now (`outerHeld`), how much of
 * the view the discs cover, in whole percent, 100 only for all of it, and
 * whether the view was cut to the part around the look-at point (`view`,
 * from X-Flight-View-Covered and X-Flight-View-Clipped), when its oldest
 * disc but the centre's was read (`outerReadAt`, epoch ms by this clock)
 * and, when it held more aircraft than the server gives, how many of how
 * many it kept (`capped`).
 */
function adsbLolQuota(response, payload, query, nowMs) {
  const budget = /^(\d+)\/(\d+)$/.exec(
    String(header(response, 'x-adsblol-budget') ?? '').trim(),
  );
  const locked = Date.parse(
    header(response, 'x-adsblol-locked-until') ||
      (typeof payload?.lockedUntil === 'string' ? payload.lockedUntil : ''),
  );
  if (!budget && !Number.isFinite(locked)) return null;
  const anchor = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(
    String(header(response, 'x-flight-anchor') ?? '').trim(),
  );
  const gap = /^\d+$/.exec(
    String(header(response, 'x-adsblol-gap-seconds') ?? '').trim(),
  );
  const asked =
    Number.isFinite(query?.latitude) && Number.isFinite(query?.longitude);
  const pair = (name) =>
    /^(\d+)\/(\d+)$/.exec(String(header(response, name) ?? '').trim());
  const discs = pair('x-flight-discs');
  const capped = pair('x-flight-capped');
  const whole = (name, pattern = /^\d+$/) =>
    pattern.exec(String(header(response, name) ?? '').trim());
  const outerAge = whole('x-flight-outer-age-seconds');
  const kept = whole('x-flight-discs-kept');
  const gaps = whole('x-flight-gap-seconds', /^(\d+)(?:\/(\d+))?$/);
  const covered = whole('x-flight-view-covered');
  return {
    used: budget ? Number(budget[1]) : null,
    limit: budget ? Number(budget[2]) : null,
    keyed: header(response, 'x-adsblol-keyed') === '1',
    keyRefused: header(response, 'x-adsblol-key-refused') === '1',
    lockedUntil: Number.isFinite(locked) ? locked : null,
    cache:
      String(header(response, 'x-opensky-cache') ?? '')
        .trim()
        .toUpperCase() || null,
    gapMs: gap ? Number(gap[0]) * 1000 : null,
    anchor: anchor
      ? { latitude: Number(anchor[1]), longitude: Number(anchor[2]) }
      : null,
    asked: asked
      ? { latitude: query.latitude, longitude: query.longitude }
      : null,
    ...(discs
      ? {
          discs: {
            shown: Number(discs[1]),
            total: Number(discs[2]),
            kept: kept ? Number(kept[0]) : Number(discs[2]),
          },
        }
      : {}),
    ...(discs && gaps
      ? {
          gaps: {
            centreMs: Number(gaps[1]) * 1000,
            outerMs: gaps[2] ? Number(gaps[2]) * 1000 : null,
          },
        }
      : {}),
    ...(discs
      ? { outerHeld: header(response, 'x-flight-outer-held') === '1' }
      : {}),
    ...(discs && covered
      ? {
          view: {
            covered: Math.min(100, Number(covered[0])),
            clipped: header(response, 'x-flight-view-clipped') === '1',
          },
        }
      : {}),
    ...(discs && outerAge
      ? { outerReadAt: nowMs - Number(outerAge[0]) * 1000 }
      : {}),
    ...(discs && capped
      ? { capped: { count: Number(capped[1]), of: Number(capped[2]) } }
      : {}),
  };
}

/** A view extent as the flights feed sends it: `west,south,east,north`. */
function bboxParam(bbox) {
  const edges = [bbox?.west, bbox?.south, bbox?.east, bbox?.north];
  return edges.every(Number.isFinite)
    ? edges.map((edge) => edge.toFixed(2)).join(',')
    : null;
}

/** A paced adsb.lol disc is no older than its gap; this margin covers transit. */
const PACED_STALE_MARGIN_MS = 60_000;
/** The live contract's own word on staleness, for every other answer. */
const STALE_AFTER_MS = 120_000;

/** The flights feed (/api/flights); no request starts during construction. */
export function createFlightSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    // i18n-ignore: feed source name, replaced by the provider from each snapshot and reported to AI tools
    label: 'Flights',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
        // Swedish fork: the ground in view, for a whole view's outer discs.
        const bbox = bboxParam(query.bbox);
        if (bbox) params.set('bbox', bbox);
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/flights${params.size ? '?' + params : ''}`,
        { signal },
        'Flights',
      );
      const quota = adsbLolQuota(response, payload, query, now());
      if (!response.ok) {
        const error = openSkyError(response, now());
        if (quota) error.quota = quota;
        throw error;
      }
      return {
        ...openSkySnapshot(payload, {
          // A fallback provider names itself in X-Flight-Source.
          source:
            header(response, 'x-flight-source') ||
            feedSource(response, 'Flights'),
          coverage:
            header(response, 'x-flight-coverage') ||
            'worldwide upstream snapshot',
          now: now(),
          // A paced adsb.lol disc is as old as the quota means it to be.
          staleAfterMs:
            quota?.cache === 'PACED' && quota.gapMs !== null
              ? Math.max(STALE_AFTER_MS, quota.gapMs + PACED_STALE_MARGIN_MS)
              : STALE_AFTER_MS,
        }),
        status: response.status,
        ...(quota ? { quota } : {}),
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/flights/track?icao24=' + encodeURIComponent(reference),
        { signal },
        'Flights',
      );
      if (!response.ok) throw httpError(response, 'Flights');
      return {
        records: normalizeAircraftTrack(payload?.path),
        complete: false,
      };
    },
    async getEnrichment(query, { signal } = {}) {
      if (query.kind === 'photo')
        return planespottersPhoto(fetchImpl, query.id, signal);
      if (!['type', 'route'].includes(query.kind))
        throw new LiveSourceError('unsupported', 'Enrichment unavailable');
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/adsbdb/${query.kind}/${encodeURIComponent(query.id)}`,
        { signal },
        'adsbdb',
      );
      if (!response.ok) throw httpError(response, 'adsbdb');
      return payload;
    },
  };
}

/**
 * The Swedish fork does not offer military aircraft: this source answers
 * with none and never asks the server. The military layer, the
 * classification that tints flights, Contacts, Cockpit and the AI tools keep
 * working and simply find nothing.
 * @param {{now?: () => number}} [options]
 */
export function createEmptyMilitarySource({ now = () => Date.now() } = {}) {
  return {
    // i18n-ignore: feed source name, reported to AI tools
    label: 'Military aircraft',
    async getIdentities() {
      return [];
    },
    async getSnapshot() {
      const at = now();
      return {
        ...readsbSnapshot({ ac: [] }, { observedAtMs: at, now: at }),
        status: 200,
      };
    },
  };
}

export function createMilitarySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    // i18n-ignore: feed source name, replaced by the provider from each snapshot and reported to AI tools
    label: 'Military aircraft',
    async getIdentities(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/military',
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      return readsbIdentities(payload);
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/military',
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      const age = finite(header(response, 'x-feed-age-ms'));
      return {
        ...readsbSnapshot(payload, {
          source: feedSource(response, 'Military aircraft'),
          observedAtMs: now() - (age != null && age > 0 ? age : 0),
          now: now(),
          stale: header(response, 'x-feed-cache') === 'STALE',
        }),
        status: response.status,
      };
    },
    // ADSB.lol does not expose a supported live-history endpoint. Omitting
    // optional getTrack keeps the tracking layer on its accumulated trail.
  };
}

export function createVesselSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/vessels',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  return {
    // i18n-ignore: feed source name, replaced by the provider from each snapshot and reported to AI tools
    label: 'Vessels',
    async getSnapshot({ maxRows = 12000, area } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      // An area asks for the vessels around a point; servers that hold every
      // vessel may ignore it, since callers still keep only what they need.
      if (
        Number.isFinite(area?.lat) &&
        Number.isFinite(area?.lon) &&
        Number.isFinite(area?.radiusKm)
      ) {
        url.searchParams.set('lat', area.lat.toFixed(5));
        url.searchParams.set('lon', area.lon.toFixed(5));
        url.searchParams.set('radius_km', area.radiusKm.toFixed(1));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'Vessels',
      );
      if (!response.ok) {
        const error = httpError(response, 'Vessels');
        const reasons = {
          'missing-key': 'AISSTREAM_API_KEY not set',
          'auth-failed': 'API key rejected — check AISSTREAM_API_KEY',
          unsupported: 'live feed unsupported',
          error: 'feed down',
          closed: 'feed disconnected',
        };
        error.message = reasons[payload?.status] || error.message;
        // No key is not an outage: the feed waits for one.
        if (payload?.status === 'missing-key') error.code = 'key-required';
        throw error;
      }
      return {
        ...vesselSnapshot(payload, { source: feedSource(response, 'Vessels') }),
        status: response.status,
      };
    },
    async getEnrichment(query, { signal } = {}) {
      if (query.kind !== 'photo')
        throw new LiveSourceError('unsupported', 'Enrichment unavailable');
      return fetchOpenVesselPhoto(fetchImpl, query.id, signal);
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/vessels/track?mmsi=' + encodeURIComponent(reference),
        { signal },
        'Vessels',
      );
      if (!response.ok) throw httpError(response, 'Vessels');
      return {
        records: normalizeVesselTrack(payload?.samples),
        complete: false,
      };
    },
  };
}
