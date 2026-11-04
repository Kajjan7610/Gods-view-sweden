/**
 * Trafikverket (Sweden) road weather: pure parsing shared by the server proxy
 * and the layer. No Cesium, no Node built-ins.
 *
 * WeatherMeasurepoint (Road.WeatherInfo 2.1) of Trafikverket's open traffic
 * API (CC0 1.0): some 830 road weather stations with road-surface and air
 * temperature, dew point, wind, visibility and precipitation, sampled every
 * 5 to 10 minutes. About 55 also measure ice, snow, water and grip on the
 * road surface; "Fjärryta" stations are remote surface sensors (bridges and
 * the like) that report only the road-surface temperature.
 */

/** Temperature classes, coldest first; a value belongs to the first class whose max it does not exceed. */
export const TEMPERATURE_CLASSES = Object.freeze([
  Object.freeze({ id: 'below-10', max: -10, color: '#b388ff' }),
  Object.freeze({ id: 'minus-10-5', max: -5, color: '#448aff' }),
  Object.freeze({ id: 'minus-5-0', max: 0, color: '#4dd0e1' }),
  Object.freeze({ id: 'zero-3', max: 3, color: '#ffee58' }),
  Object.freeze({ id: 'three-8', max: 8, color: '#9ccc65' }),
  Object.freeze({ id: 'above-8', max: Infinity, color: '#ffa726' }),
]);
export const NO_READING_COLOR = '#9e9e9e';
/** The ring drawn around a station with a risk of ice. */
export const ICE_RISK_COLOR = '#ffffff';

/** Ice or snow a surface sensor reports is trusted only on a road this cold. */
const MEASURED_ICE_MAX_C = 1;
/** Stations whose newest sample is older than this are out of service. */
export const MAX_SAMPLE_AGE_MS = 6 * 60 * 60_000;
export const MAX_STATIONS = 5000;
const MAX_TEXT = 120;

/**
 * @param {number|null} celsius
 * @returns {object|null} One of TEMPERATURE_CLASSES, or null without a reading.
 */
export function temperatureClass(celsius) {
  if (!Number.isFinite(celsius)) return null;
  return TEMPERATURE_CLASSES.find((entry) => celsius <= entry.max) || null;
}

export function temperatureColor(celsius) {
  return temperatureClass(celsius)?.color || NO_READING_COLOR;
}

/**
 * Why a station's road may be slippery, or null:
 *   'measured' — the surface sensor reports ice or snow on a road at most +1 °C;
 *   'precipitation' — rain, sleet or snow on a road at or below 0 °C;
 *   'frost' — a road at or below 0 °C and colder than the dew point.
 * @param {object} row A normalized station.
 * @returns {'measured'|'precipitation'|'frost'|null}
 */
export function iceRisk(row) {
  const surface = row?.surfaceTemp;
  const known = Number.isFinite(surface);
  if (
    (row?.surfaceIce || row?.surfaceSnow) &&
    (!known || surface <= MEASURED_ICE_MAX_C)
  )
    return 'measured';
  if (!known || surface > 0) return null;
  if (row.precipitation && row.precipitation !== 'no') return 'precipitation';
  if (Number.isFinite(row.dewpoint) && surface <= row.dewpoint) return 'frost';
  return null;
}

const text = (value, max = MAX_TEXT) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const flag = (value) => (typeof value === 'boolean' ? value : null);
const reading = (node) => num(node?.Value);

/** "POINT (lon lat)" to [lon, lat], or null. */
export function parsePoint(wkt) {
  const match =
    /^POINT\s*(?:Z|M|ZM)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(
      String(wkt ?? '').trim(),
    );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;
  return [lon, lat];
}

/**
 * Normalize one WeatherMeasurepoint; null when it has no place, no fresh
 * sample or no temperature at all.
 * @param {object} record
 * @param {number} nowMs
 */
export function normalizeWeatherStation(record, nowMs) {
  const id = text(record?.Id, 40);
  const point = parsePoint(record?.Geometry?.WGS84);
  if (!id || !point) return null;
  const observation = record.Observation || {};
  const sampled = Date.parse(String(observation.Sample ?? ''));
  if (!Number.isFinite(sampled) || nowMs - sampled > MAX_SAMPLE_AGE_MS)
    return null;
  const surface = observation.Surface || {};
  const air = observation.Air || {};
  const wind = (Array.isArray(observation.Wind) ? observation.Wind : []).find(
    (entry) => reading(entry?.Speed) != null,
  );
  const row = {
    id,
    name: text(record.Name) || id,
    point,
    sampled,
    surfaceTemp: reading(surface.Temperature),
    airTemp: reading(air.Temperature),
    dewpoint: reading(air.Dewpoint),
    humidity: reading(air.RelativeHumidity),
    visibility: reading(air.VisibleDistance),
    windSpeed: reading(wind?.Speed),
    windDirection: reading(wind?.Direction),
    windGust: reading(observation.Aggregated10minutes?.Wind?.SpeedMax),
    precipitation: text(observation.Weather?.Precipitation, 30)?.toLowerCase(),
    precipitation30: reading(
      observation.Aggregated30minutes?.Precipitation?.TotalWaterEquivalent,
    ),
    surfaceIce: flag(surface.Ice),
    surfaceSnow: flag(surface.Snow),
    surfaceWater: flag(surface.Water),
    grip: reading(surface.Grip),
  };
  if (row.surfaceTemp == null && row.airTemp == null) return null;
  row.precipitation ??= null;
  row.risk = iceRisk(row);
  return row;
}

/**
 * Normalize the API answer.
 * @param {object} payload Parsed JSON body.
 * @param {number} nowMs
 * @returns {{stations: object[], truncated: boolean}}
 */
export function normalizeWeatherSnapshot(payload, nowMs) {
  const results = Array.isArray(payload?.RESPONSE?.RESULT)
    ? payload.RESPONSE.RESULT
    : [];
  const failure = results.find((result) => result?.ERROR);
  if (failure) {
    const error = new Error(
      `Trafikverket refused the query: ${String(
        failure.ERROR.MESSAGE || failure.ERROR.SOURCE || 'error',
      ).slice(0, 200)}`,
    );
    error.status = failure.ERROR.SOURCE === 'Security' ? 401 : 400;
    throw error;
  }
  const records = results.flatMap((result) =>
    Array.isArray(result?.WeatherMeasurepoint)
      ? result.WeatherMeasurepoint
      : [],
  );
  const stations = [];
  const seen = new Set();
  for (const record of records) {
    if (stations.length >= MAX_STATIONS) break;
    if (record?.Deleted === true) continue;
    const row = normalizeWeatherStation(record, nowMs);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    stations.push(row);
  }
  return { stations, truncated: records.length > MAX_STATIONS };
}
