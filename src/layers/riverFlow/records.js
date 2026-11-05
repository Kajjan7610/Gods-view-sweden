/**
 * SMHI river flow: pure parsing shared by the server proxy and the layer.
 * No Cesium, no Node built-ins.
 *
 * SMHI's hydrological observations (opendata-download-hydroobs.smhi.se,
 * CC BY 4.0, no key) publish discharge every 15 minutes; one station-set
 * request returns the last hour of every reporting station — some 150 — with
 * its river (catchment) and catchment area.
 */

/** Discharge classes in m³/s, smallest first; `max` is exclusive. */
export const FLOW_CLASSES = Object.freeze([
  Object.freeze({ id: 'brook', max: 1, color: '#b3e5fc', size: 6 }),
  Object.freeze({ id: 'stream', max: 10, color: '#4fc3f7', size: 8 }),
  Object.freeze({ id: 'river', max: 50, color: '#0288d1', size: 10 }),
  Object.freeze({ id: 'large', max: 150, color: '#1a237e', size: 13 }),
  Object.freeze({ id: 'major', max: Infinity, color: '#6a1b9a', size: 16 }),
]);
/** Below this change over the hour the flow reads as steady (share of flow). */
export const STEADY_SHARE = 0.02;

export function flowClass(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return FLOW_CLASSES.find((entry) => value < entry.max) || null;
}

/** "KALIXÄLVEN" as "Kalixälven"; names keep their inner capitals otherwise. */
export function properName(value) {
  const s = String(value ?? '')
    .trim()
    .slice(0, 80);
  if (!s || s !== s.toLocaleUpperCase('sv-SE')) return s;
  return s
    .toLocaleLowerCase('sv-SE')
    .replace(/(^|[\s(/-])(\p{L})/gu, (_, gap, letter) =>
      gap.concat(letter.toLocaleUpperCase('sv-SE')),
    );
}

/**
 * One station with its latest discharge and the change over the hour; null
 * without a place in Sweden or without a usable reading.
 * @param {object} station A station of the station-set answer.
 */
export function normalizeFlowStation(station) {
  const lat = Number(station?.latitude);
  const lon = Number(station?.longitude);
  if (
    station?.key == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 54 ||
    lat > 70 ||
    lon < 9 ||
    lon > 25
  )
    return null;
  const samples = (Array.isArray(station.value) ? station.value : [])
    .map((sample) => ({
      at: Number(sample?.date),
      value: Number(sample?.value),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.at) &&
        Number.isFinite(sample.value) &&
        sample.value >= 0,
    )
    .sort((a, b) => a.at - b.at);
  const last = samples.at(-1);
  if (!last) return null;
  const first = samples[0];
  const area = Number(station.catchmentSize);
  return {
    id: String(station.key).slice(0, 12),
    name: properName(station.name) || String(station.key),
    river: properName(station.catchmentName) || null,
    catchmentKm2: Number.isFinite(area) && area > 0 ? area : null,
    point: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4],
    flow: last.value,
    // Change since the hour's first sample; null with a single sample.
    change:
      samples.length > 1
        ? Math.round((last.value - first.value) * 1000) / 1000
        : null,
    updated: last.at,
  };
}

/** Rising, falling or steady over the hour; null without two samples. */
export function flowTrend(row) {
  if (!Number.isFinite(row?.change)) return null;
  const threshold = Math.max(0.01, row.flow * STEADY_SHARE);
  if (row.change > threshold) return 'rising';
  if (row.change < -threshold) return 'falling';
  return 'steady';
}

/**
 * Every reporting station, largest flow first.
 * @param {object} payload SMHI's station-set answer.
 */
export function normalizeFlowStations(payload) {
  if (!Array.isArray(payload?.station))
    throw new Error('Malformed SMHI river flow answer');
  return payload.station
    .map(normalizeFlowStation)
    .filter(Boolean)
    .sort((a, b) => b.flow - a.flow || a.name.localeCompare(b.name, 'sv'));
}
