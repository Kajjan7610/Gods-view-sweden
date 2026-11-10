import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// SMHI's air-quality database (Datavärdskap luft, open data, no key) through
// its 52North REST API. It holds some 1,300 NO2/PM10/PM2.5/O3 series, most of
// them retired, so the series worth asking for are discovered rarely: each
// pollutant's list is read (the whole list at once outlasts SMHI's gateway),
// every series is asked for its last day of values, and the ones that
// answered are kept on disk for a week. GET / then asks only those for their last hours, cached
// half an hour (the values are hourly), and answers one row per station.
export const API_BASE = 'https://datavardluft.smhi.se/52North/api';
const POLLUTANT_LABEL = /^(NO2|PM10|PM2\.5|O3) /;
/** EEA (Eionet) pollutant codes, which are SMHI's phenomenon ids. */
export const PHENOMENA = Object.freeze({
  NO2: 8,
  PM10: 5,
  'PM2.5': 6001,
  O3: 7,
});
const DISCOVERY_TTL_MS = 7 * 24 * 60 * 60_000;
const VALUES_TTL_MS = 30 * 60_000;
/** How long SMHI is left alone after a failed refresh. */
export const SMHI_AIR_QUALITY_RETRY_AFTER_FAILURE_MS = 60_000;
/** Longest a failed refresh keeps serving the last stations, marked stale. */
const STALE_MAX_MS = 3 * 60 * 60_000;
const BATCH = 100;
const LIST_TIMEOUT_MS = 120_000;
const DATA_TIMEOUT_MS = 60_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_DATA_BYTES = 8 * 1024 * 1024;
const HOUR_MS = 60 * 60_000;
/** A failed discovery is not tried again for this long. */
const DISCOVERY_RETRY_MS = 10 * 60_000;

/** "2026-11-04T23:00:00Z": the end of the hour `ms` falls in. */
function hourEnd(ms) {
  return new Date(Math.ceil(ms / HOUR_MS) * HOUR_MS)
    .toISOString()
    .replace('.000Z', 'Z');
}

/**
 * The series worth asking for from a timeseries listing: the four EAQI
 * pollutants, with the station's name and position.
 * @param {Array<object>} list
 * @returns {Array<{id: string, pollutant: string, name: string, lat: number, lon: number}>}
 */
export function pollutantSeries(list) {
  const out = [];
  for (const series of Array.isArray(list) ? list : []) {
    const match = POLLUTANT_LABEL.exec(String(series?.label || ''));
    const [lon, lat] = series?.station?.geometry?.coordinates || [];
    if (!match || !series.id || !Number.isFinite(lat) || !Number.isFinite(lon))
      continue;
    out.push({
      id: String(series.id),
      pollutant: match[1],
      name: String(series.station?.properties?.label || '').trim(),
      lat,
      lon,
    });
  }
  return out;
}

/** The newest finite value of one getData answer, or null. */
function latestValue(entry) {
  let best = null;
  for (const sample of entry?.values || []) {
    const at =
      typeof sample?.timestamp === 'number'
        ? sample.timestamp
        : Date.parse(sample?.timestamp);
    const value = Number(sample?.value);
    if (
      sample?.value == null ||
      !Number.isFinite(at) ||
      !Number.isFinite(value)
    )
      continue;
    if (!best || at > best.at) best = { value, at };
  }
  return best;
}

/**
 * One row per station from the series and their latest values. Series of the
 * same place share a station; of two series of one pollutant the newer wins.
 * @param {Array<object>} series
 * @param {Map<string, {value: number, at: number}>} latest
 */
export function groupStations(series, latest) {
  const stations = new Map();
  for (const one of series) {
    const sample = latest.get(one.id);
    if (!sample) continue;
    const id = `${one.lat.toFixed(4)},${one.lon.toFixed(4)}`;
    let station = stations.get(id);
    if (!station) {
      station = {
        id,
        name: one.name,
        lat: one.lat,
        lon: one.lon,
        pollutants: {},
      };
      stations.set(id, station);
    }
    const known = station.pollutants[one.pollutant];
    if (!known || sample.at > known.at)
      station.pollutants[one.pollutant] = sample;
  }
  return [...stations.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Bounded SMHI air-quality route for dev and preview. */
export function smhiAirQualityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'smhi-air-quality-series.json',
  ),
} = {}) {
  /** @type {?{at: number, series: Array<object>}} */
  let discovered = null;
  let diskRead = null;
  let snapshot = null;
  let retryAfter = 0;
  let discoveryFailedAt = -Infinity;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  async function request(url, init, timeoutMs, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      return await readResponseJsonCapped(response, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Latest value per series id over the `hours` before now, in batches. */
  async function latestValues(ids, hours) {
    const latest = new Map();
    const timespan = `PT${hours}H/${hourEnd(now())}`;
    for (let i = 0; i < ids.length; i += BATCH) {
      const answer = await request(
        `${API_BASE}/timeseries/getData`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            timeseries: ids.slice(i, i + BATCH),
            timespan,
          }),
        },
        DATA_TIMEOUT_MS,
        MAX_DATA_BYTES,
      );
      for (const [id, entry] of Object.entries(answer || {})) {
        const sample = latestValue(entry);
        if (sample) latest.set(id, sample);
      }
    }
    return latest;
  }

  /**
   * The series kept on disk, read once: requests arriving while it is read
   * wait for it, so none of them starts a discovery the disk makes needless.
   */
  function readDiskOnce() {
    diskRead ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.series))
          discovered = parsed;
      } catch {
        /* no disk cache yet */
      }
    })();
    return diskRead;
  }

  async function discover() {
    const candidates = [];
    for (const phenomenon of Object.values(PHENOMENA)) {
      const list = await request(
        `${API_BASE}/timeseries?phenomenon=${phenomenon}`,
        { headers: { Accept: 'application/json' } },
        LIST_TIMEOUT_MS,
        MAX_LIST_BYTES,
      );
      candidates.push(...pollutantSeries(list));
    }
    const latest = await latestValues(
      candidates.map((series) => series.id),
      24,
    );
    const entry = {
      at: now(),
      series: candidates.filter((series) => latest.has(series.id)),
    };
    if (!entry.series.length) throw new Error('no active series');
    console.log(
      `[smhi-air-quality] ${entry.series.length} of ${candidates.length} series active`,
    );
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn(
        `[smhi-air-quality] cache write failed: ${error?.message || error}`,
      );
    }
    discovered = entry;
    return entry;
  }

  /** Start (or join) a discovery without waiting for it. */
  function discoverInBackground() {
    if (now() - discoveryFailedAt < DISCOVERY_RETRY_MS) return;
    const { promise, shared } = coalesceProxyRequest(
      inFlight,
      'discover',
      discover,
    );
    if (shared) return;
    promise.catch((error) => {
      discoveryFailedAt = now();
      console.warn(
        `[smhi-air-quality] discovery failed: ${error?.message || error}`,
      );
    });
  }

  async function loadStations() {
    const { series } = discovered;
    const latest = await latestValues(
      series.map((one) => one.id),
      3,
    );
    const at = now();
    return { stations: groupStations(series, latest), fetchedAt: at };
  }

  /** The last stations marked stale, or null once too old to show. */
  const lastKnown = () =>
    snapshot && now() - snapshot.savedAt <= STALE_MAX_MS
      ? { ...snapshot.value, stale: true }
      : null;

  /**
   * One read of SMHI, shared by everyone waiting on it: the new stations,
   * or after a failure the last ones (null without any).
   */
  async function refresh() {
    try {
      const value = await loadStations();
      snapshot = { value, savedAt: now() };
      retryAfter = 0;
      console.log(`[smhi-air-quality] ${value.stations.length} stations`);
      return value;
    } catch (error) {
      console.warn(
        `[smhi-air-quality] refresh failed: ${error?.message || error}`,
      );
      retryAfter = now() + SMHI_AIR_QUALITY_RETRY_AFTER_FAILURE_MS;
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
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    if (snapshot && now() - snapshot.savedAt < VALUES_TTL_MS)
      return json(200, snapshot.value);
    await readDiskOnce();
    if (!discovered) {
      discoverInBackground();
      return json(503, { error: 'warming_up' }, { 'Retry-After': '120' });
    }
    // A week-old list still answers while a fresh one is gathered.
    if (now() - discovered.at > DISCOVERY_TTL_MS) discoverInBackground();
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    const value =
      now() < retryAfter
        ? lastKnown()
        : await coalesceProxyRequest(inFlight, 'values', refresh).promise;
    if (!value) return json(502, { error: 'smhi_air_quality_unavailable' });
    return json(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return {
    name: 'smhi-air-quality',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-quality-se', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-quality-se', handler);
    },
  };
}
