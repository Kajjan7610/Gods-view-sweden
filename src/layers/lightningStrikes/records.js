/**
 * Lightning strikes from DMI (Danmarks Meteorologiske Institut): pure parsing
 * shared by the server proxy and the layer. No Cesium, no Node built-ins.
 *
 * DMI's open lightning API (CC BY 4.0, no key) returns each triangulated
 * stroke from its sensor network in Denmark and partner sensors around it,
 * which reaches all of Sweden. Each stroke has a time, a position (500–2000 m
 * accurate over Denmark, coarser farther away), a peak current in kA, the
 * sensors that located it and a type: 0 cloud-to-ground negative, 1
 * cloud-to-ground positive, 2 cloud-to-cloud.
 */

/** How far back the layer shows strokes. */
export const WINDOW_MS = 60 * 60_000;

/** Age classes, newest first; `max` is exclusive, in minutes. */
export const AGE_CLASSES = Object.freeze(
  [
    [5, '#ffffff'],
    [15, '#ffd54f'],
    [30, '#ff9800'],
    [60, '#e53935'],
  ].map(([max, color], index, all) =>
    Object.freeze({ min: index ? all[index - 1][0] : 0, max, color }),
  ),
);

export function ageClass(ageMs) {
  const minutes = ageMs / 60_000;
  if (!Number.isFinite(minutes) || minutes < 0) return AGE_CLASSES[0];
  return AGE_CLASSES.find((entry) => minutes < entry.max) || null;
}

const KINDS = Object.freeze({
  0: 'ground-negative',
  1: 'ground-positive',
  2: 'cloud',
});

/** A number, or a string holding one; null and '' are no value, not 0. */
const numeric = (value) =>
  typeof value === 'number' || (typeof value === 'string' && value.trim())
    ? Number(value)
    : NaN;

/**
 * One stroke, or null without a time or a place in the Nordic window.
 * @param {object} feature A GeoJSON Point feature from DMI.
 */
export function normalizeStrike(feature) {
  const [lon, lat] = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates.map(numeric)
    : [];
  const props = feature?.properties || {};
  const at = Date.parse(props.observed);
  const id = String(feature?.id ?? '')
    .replace(/[^\w-]/g, '')
    .slice(0, 48);
  if (
    !id ||
    !Number.isFinite(at) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 50 ||
    lat > 75 ||
    lon < 0 ||
    lon > 35
  )
    return null;
  const amp = numeric(props.amp);
  const sensors =
    typeof props.sensors === 'string'
      ? props.sensors.split(',').filter(Boolean).length
      : null;
  return {
    id,
    point: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4],
    at,
    kind: KINDS[props.type] ?? null,
    amp: Number.isFinite(amp) ? Math.round(amp * 10) / 10 : null,
    sensors,
  };
}

/**
 * The strokes of the last {@link WINDOW_MS}, newest first, without repeats.
 * @param {object[]} features DMI GeoJSON features, from one or more pages.
 * @param {number} nowMs
 */
export function normalizeStrikes(features, nowMs) {
  if (!Array.isArray(features))
    throw new Error('Malformed lightning collection');
  const seen = new Set();
  return features
    .map(normalizeStrike)
    .filter(
      (row) =>
        row &&
        nowMs - row.at <= WINDOW_MS &&
        row.at <= nowMs + 60_000 &&
        !seen.has(row.id) &&
        seen.add(row.id),
    )
    .sort((a, b) => b.at - a.at);
}
