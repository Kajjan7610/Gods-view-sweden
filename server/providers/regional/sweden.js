import { fetchRegionalJson } from './http.js';
import { warningLevel } from '../../../src/layers/smhiWarnings/records.js';
import {
  sharedKrisinformationFeed,
  sharedSmhiWarningsFeed,
} from '../swedishAlertFeeds.js';
import {
  SWEDISH_COUNTIES,
  createCountyLookup,
  normalizeCrisisItems,
} from '../../../src/layers/smhiWarnings/crisis.js';
import { createPlaceLookup } from '../../../src/layers/policeEvents/records.js';
import { SWEDISH_MUNICIPALITIES } from '../polisen/municipalities.js';
import { greatCircleKm } from '../../../src/geoDistance.js';

// The cockpit briefing over Sweden reads Swedish sources (all CC BY 4.0 or
// open, no key): SMHI's point forecast for the conditions, SMHI's warnings
// and Krisinformation's VMAs for what is in effect where the aircraft is.

const SWEDEN_BOX = Object.freeze({
  west: 10.5,
  south: 55.0,
  east: 24.3,
  north: 69.1,
});
const SMHI_FORECAST_URL = (lon, lat) =>
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`;
/** A VMA that can no longer be confirmed is left out after this long. */
const VMA_STALE_MAX_MS = 60 * 60_000;
const MAX_ALERTS = 3;
/** A VMA placed at a town or county counts within this distance. */
const VMA_RADIUS_KM = 100;

const crisisLookups = {
  places: createPlaceLookup(SWEDISH_MUNICIPALITIES),
  counties: createCountyLookup(SWEDISH_MUNICIPALITIES),
};

/** Whether a point may be in Sweden; the place's country code decides. */
export function maybeInSweden(point) {
  const { west, south, east, north } = SWEDEN_BOX;
  return (
    point.longitude >= west &&
    point.longitude <= east &&
    point.latitude >= south &&
    point.latitude <= north
  );
}

/** Within this distance of a municipality seat a point is in Sweden. */
const SEAT_RADIUS_KM = 50;

/**
 * The nearest municipality seat as the briefing's place, or null when no
 * seat is near enough to call the point Swedish.
 * @param {{latitude: number, longitude: number}} point
 * @param {Array<[string, string, string, number, number]>} [rows]
 */
export function swedishPlaceAt(point, rows = SWEDISH_MUNICIPALITIES) {
  const seat = nearestSeat(point, SEAT_RADIUS_KM, rows);
  if (!seat) return null;
  return {
    label: [seat.locality, seat.county].filter(Boolean).join(', '),
    locality: seat.locality,
    region: seat.county,
    country: 'Sverige',
    countryCode: 'SE',
    source: 'Wikidata',
  };
}

/**
 * The municipality whose seat is nearest a point, within `maxKm`, or null.
 * `municipality` is the list's name, often genitive ("Stockholms"); the
 * seat is the town ("Stockholm").
 * @param {{latitude: number, longitude: number}} point
 * @param {number} maxKm
 * @param {Array<[string, string, string, number, number]>} [rows]
 */
export function nearestSeat(point, maxKm, rows = SWEDISH_MUNICIPALITIES) {
  const here = { lat: point.latitude, lon: point.longitude };
  let best = null;
  for (const row of rows) {
    const km = greatCircleKm(here, { lat: row[4], lon: row[3] });
    if (km <= maxKm && (!best || km < best.km)) best = { row, km };
  }
  if (!best) return null;
  const [code, municipality, seat, lon, lat] = best.row;
  return {
    code,
    municipality,
    locality: seat || municipality,
    county: SWEDISH_COUNTIES[code.slice(0, 2)] || null,
    point: [lon, lat],
    km: Math.round(best.km * 10) / 10,
  };
}

/** SMHI weather symbol (1–27) as the WMO code the briefing labels. */
export function smhiSymbolToWmo(symbol) {
  const n = Math.round(Number(symbol));
  if (!Number.isFinite(n)) return null;
  if (n === 1) return 0;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n === 7) return 45;
  if (n <= 10) return 80;
  if (n === 11 || n === 21) return 95;
  if (n <= 17) return 85; // sleet showers read as snow showers
  if (n <= 20) return 61;
  if (n <= 24) return 66; // sleet reads as rain
  if (n <= 27) return 71;
  return null;
}

const finite = (value) =>
  value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);

/**
 * The forecast step for the current hour as the briefing's weather record.
 * @param {object} payload snow1g point JSON
 * @param {number} nowMs
 */
export function normalizeSmhiNow(payload, nowMs) {
  const steps = Array.isArray(payload?.timeSeries) ? payload.timeSeries : [];
  const step = steps
    .map((entry) => ({ at: Date.parse(entry?.time), data: entry?.data || {} }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at <= nowMs + 3600e3)
    .at(-1);
  const temperature = finite(step?.data.air_temperature);
  if (!step || temperature == null) return null;
  const wind = finite(step.data.wind_speed);
  const octas = finite(step.data.cloud_area_fraction);
  const visibilityKm = finite(step.data.visibility_in_air);
  return {
    observedAt: new Date(step.at).toISOString(),
    temperatureC: temperature,
    apparentTemperatureC: null,
    precipitationMm: finite(step.data.precipitation_amount_mean),
    cloudCoverPct: octas == null ? null : Math.round((octas / 8) * 100),
    windKph: wind == null ? null : Math.round(wind * 3.6 * 10) / 10,
    windDirectionDeg: finite(step.data.wind_from_direction),
    visibilityM: visibilityKm == null ? null : visibilityKm * 1000,
    weatherCode: smhiSymbolToWmo(step.data.symbol_code),
  };
}

function insideRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function covers(polygons, lon, lat) {
  return polygons.some(
    ({ outer, holes }) =>
      insideRing(outer, lon, lat) &&
      !holes.some((hole) => insideRing(hole, lon, lat)),
  );
}

/**
 * The warnings and VMAs that apply at a point, most severe first: SMHI
 * warning areas whose polygon holds it, then VMAs nationwide or near it.
 * @param {{areas: object[]}} warnings normalized SMHI warnings
 * @param {object[]} crisis normalized Krisinformation items
 * @param {{latitude: number, longitude: number}} point
 */
export function alertsAt(warnings, crisis, point) {
  const { latitude: lat, longitude: lon } = point;
  const vmas = (crisis || [])
    .filter(
      (item) =>
        item.kind === 'vma' &&
        (item.scope === 'country' ||
          greatCircleKm(
            { lat, lon },
            { lat: item.point?.[1], lon: item.point?.[0] },
          ) <= VMA_RADIUS_KM),
    )
    .map((item) => ({
      kind: 'vma',
      level: 'VMA',
      title: { sv: item.headline, en: item.headline },
      area: item.place ? { sv: item.place, en: item.place } : null,
      start: item.published,
      end: null,
    }));
  const areas = (warnings?.areas || [])
    .filter((area) => covers(area.polygons || [], lon, lat))
    .sort(
      (a, b) =>
        (warningLevel(b.level)?.rank ?? 0) - (warningLevel(a.level)?.rank ?? 0),
    )
    .map((area) => ({
      kind: 'warning',
      level: area.level,
      title: area.event || area.description,
      area: area.area,
      start: area.start,
      end: area.end,
    }));
  return [...vmas, ...areas].slice(0, MAX_ALERTS);
}

/** SMHI's current conditions at a point, or null. */
export async function fetchSmhiNow(point, { now = Date.now } = {}) {
  const lon = point.longitude.toFixed(3);
  const lat = point.latitude.toFixed(3);
  try {
    const payload = await fetchRegionalJson(SMHI_FORECAST_URL(lon, lat), {
      timeoutMs: 9000,
      redirect: 'error',
      maxBytes: 4 * 1024 * 1024,
    });
    return normalizeSmhiNow(payload, now());
  } catch {
    return null;
  }
}

/**
 * SMHI warnings and VMAs from the server's shared readers
 * (swedishAlertFeeds.js), which the warnings layer and the VMA banner read
 * too. A warning list SMHI no longer confirms is not shown; the last VMAs are
 * kept for an hour while Krisinformation does not answer, as on the map.
 */
async function loadAlertSources(
  now,
  {
    warningsFeed = sharedSmhiWarningsFeed(),
    crisisFeed = sharedKrisinformationFeed(),
  } = {},
) {
  const [warnings, crisis] = await Promise.all([
    warningsFeed.read(),
    crisisFeed.read().catch(() => null),
  ]);
  if (!warnings.fresh) throw new Error('SMHI warnings unavailable');
  const vmas =
    crisis && now - crisis.savedAt <= VMA_STALE_MAX_MS ? crisis.vmas : [];
  return {
    warnings: warnings.warnings,
    crisis: normalizeCrisisItems({ vmas, news: [] }, crisisLookups),
  };
}

/** What is in effect at a point: `{status, alerts}`. */
export async function fetchSwedishAlerts(
  point,
  { now = Date.now, warningsFeed, crisisFeed } = {},
) {
  try {
    const { warnings, crisis } = await loadAlertSources(now(), {
      warningsFeed,
      crisisFeed,
    });
    return { status: 'ready', alerts: alertsAt(warnings, crisis, point) };
  } catch {
    return { status: 'unavailable', alerts: [] };
  }
}
