/**
 * Strålsäkerhetsmyndigheten's gamma stations: pure parsing shared by the
 * server proxy and the layer. No Cesium, no Node built-ins.
 *
 * SSM's public map (karttjanst.ssm.se/gammastationer) reads one GeoJSON
 * document with every station of the national early-warning network — some
 * thirty — and its latest hourly ambient dose rate in microsievert per hour.
 * A negative value means the station is in service or maintenance; stations
 * that have been moved keep their old entry with a stale date.
 */

/** SSM's own colour scale (µSv/h), lowest first; `max` is exclusive. */
export const DOSE_CLASSES = Object.freeze(
  [
    [0.04, '#084081'],
    [0.08, '#0868ac'],
    [0.12, '#2b8cbe'],
    [0.16, '#4eb3b3'],
    [0.2, '#7bcc9d'],
    [0.24, '#addd8e'],
    [0.3, '#d9f0a3'],
    [1, '#ffeda0'],
    [5, '#fed976'],
    [10, '#feb24c'],
    [25, '#fd8d3c'],
    [50, '#fc4e2a'],
    [100, '#e31a1c'],
    [250, '#bd000a'],
    [Infinity, '#90000a'],
  ].map(([max, color], index, all) =>
    Object.freeze({ min: index ? all[index - 1][0] : 0, max, color }),
  ),
);
export const SERVICE_COLOR = '#626262';
/** The natural background in Sweden, as SSM states it. */
export const NORMAL_BACKGROUND = Object.freeze({ min: 0.05, max: 0.3 });
/** A station silent for longer has been moved or closed. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

export function doseClass(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return DOSE_CLASSES.find((entry) => value < entry.max) || null;
}

export function doseColor(value) {
  return doseClass(value)?.color || SERVICE_COLOR;
}

/**
 * One station, or null when it has no place in Sweden or has not reported
 * for {@link MAX_AGE_MS}. A station in service keeps its place, valueless.
 * @param {object} feature A GeoJSON Point feature from SSM.
 * @param {number} nowMs
 */
export function normalizeGammaStation(feature, nowMs) {
  const [lon, lat] = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates.map(Number)
    : [];
  const props = feature?.properties || {};
  const updated = Number(props.date);
  if (
    props.id == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 54 ||
    lat > 70 ||
    lon < 9 ||
    lon > 25 ||
    !Number.isFinite(updated) ||
    nowMs - updated > MAX_AGE_MS
  )
    return null;
  const value = props.value == null ? NaN : Number(props.value);
  return {
    id: String(props.id).slice(0, 12),
    name: String(props.name ?? props.id)
      .trim()
      .slice(0, 80),
    point: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4],
    value: Number.isFinite(value) && value >= 0 ? value : null,
    updated,
  };
}

/**
 * Every current station, highest dose rate first.
 * @param {object} payload SSM's FeatureCollection.
 * @param {number} nowMs
 */
export function normalizeGammaStations(payload, nowMs) {
  if (!Array.isArray(payload?.features))
    throw new Error('Malformed gamma station collection');
  return payload.features
    .map((feature) => normalizeGammaStation(feature, nowMs))
    .filter(Boolean)
    .sort(
      (a, b) =>
        (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name, 'sv'),
    );
}
