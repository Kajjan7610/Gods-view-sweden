import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Aviation weather for the airport board and the cockpit (Swedish fork): the
// latest METAR and TAF per airport from the NOAA Aviation Weather Center's
// open data API (aviationweather.gov, US Government work, no key). Each
// station's report is kept ten minutes; Swedish airports report every half
// hour.

export const AVIATION_WEATHER_URL =
  'https://aviationweather.gov/api/data/metar';
const REPORT_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_STATIONS = 6;
/** Cover codes that make a ceiling. */
const CEILING_COVERS = new Set(['BKN', 'OVC', 'VV']);

const text = (value, max = 400) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** ICAO codes from a query: four letters each, at most six. */
export function stationIds(value) {
  return [
    ...new Set(
      String(value ?? '')
        .toUpperCase()
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^[A-Z]{4}$/.test(id)),
    ),
  ].slice(0, MAX_STATIONS);
}

/**
 * Visibility in metres from the raw METAR ("9999" is 10 km or more,
 * CAVOK likewise), else from the API's statute miles ("6+").
 */
export function visibilityMeters(raw, visib) {
  const ob = String(raw ?? '');
  if (/\sCAVOK(\s|$)/.test(ob)) return 10_000;
  const match = /\s(\d{4})(?:NDV)?\s/.exec(
    ob.replace(/^\S+\s+\S+\s+\S+\s+(AUTO\s+)?/, ' '),
  );
  if (match) return Math.min(10_000, Number(match[1]));
  const miles = parseFloat(String(visib ?? ''));
  if (!Number.isFinite(miles)) return null;
  return Math.min(10_000, Math.round((miles * 1609.344) / 100) * 100);
}

/** One station's report as the board and the cockpit read it. */
export function normalizeMetar(row) {
  const icao = text(row?.icaoId, 4);
  if (!icao) return null;
  const raw = text(row.rawOb);
  const clouds = (Array.isArray(row.clouds) ? row.clouds : [])
    .map((layer) => ({
      cover: text(layer?.cover, 4),
      baseFt: number(layer?.base),
    }))
    .filter((layer) => layer.cover);
  const ceiling = clouds.find(
    (layer) => CEILING_COVERS.has(layer.cover) && layer.baseFt !== null,
  );
  const wdir = row.wdir;
  return {
    icao,
    name: text(row.name, 80),
    observed: Date.parse(String(row.reportTime ?? row.obsTime ?? '')) || null,
    windDir: number(wdir),
    windVariable: String(wdir).toUpperCase() === 'VRB',
    windKt: number(row.wspd),
    gustKt: number(row.wgst),
    visibilityM: visibilityMeters(raw, row.visib),
    cavok: /\sCAVOK(\s|$)/.test(raw ?? '') || row.cover === 'CAVOK',
    clouds,
    ceilingFt: ceiling?.baseFt ?? null,
    temperatureC: number(row.temp),
    dewpointC: number(row.dewp),
    qnhHpa: number(row.altim),
    weather: text(row.wxString, 40),
    category: /^(VFR|MVFR|IFR|LIFR)$/.test(row.fltCat ?? '')
      ? row.fltCat
      : null,
    metar: raw,
    taf: text(row.rawTaf, 1200),
  };
}

/** Bounded aviation weather route for dev and preview. */
export function aviationWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const reports = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function fetchStations(ids) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `${AVIATION_WEATHER_URL}?ids=${ids.join(',')}&format=json&taf=true`,
        {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'gods-eye-view (aviation weather)',
          },
        },
      );
      // 204: none of the stations has a current report.
      if (response.status === 204) return [];
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const body = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      return (Array.isArray(body) ? body : [])
        .map(normalizeMetar)
        .filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reports for `ids`, reading only the stations not kept fresh. */
  async function stations(ids) {
    const at = now();
    const stale = ids.filter(
      (id) => !(reports.get(id) && at - reports.get(id).at < REPORT_TTL_MS),
    );
    if (stale.length) {
      try {
        const read = await fetchStations(stale);
        for (const id of stale)
          reports.set(id, {
            value: read.find((report) => report.icao === id) ?? null,
            at,
          });
        if (reports.size > 200) reports.delete(reports.keys().next().value);
      } catch (error) {
        // The last reports read, if any, stand in.
        console.warn(`[aviation-weather] ${error?.message}`);
        if (!ids.some((id) => reports.has(id))) throw error;
      }
    }
    return ids.map((id) => reports.get(id)?.value).filter(Boolean);
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
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const ids = stationIds(url.searchParams.get('ids'));
    if (!ids.length) return json(400, { error: 'ids_required' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      return json(200, { reports: await stations(ids), fetchedAt: now() });
    } catch {
      return json(502, { error: 'upstream_failed' });
    }
  }

  return {
    name: 'aviation-weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/aviation-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aviation-weather', handler);
    },
  };
}
