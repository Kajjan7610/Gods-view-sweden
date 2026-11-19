/**
 * Trafikverket's frost depth (Sweden): pure parsing shared by the server
 * proxy and the layer. No Cesium, no Node built-ins.
 *
 * FrostDepthMeasurepoint (Road.WeatherInfo 1.0) of Trafikverket's open API
 * (CC0 1.0): some 70 frost rods set in the ploughed road, each a string of
 * sensors measuring the temperature down to about two metres, several times
 * a day. Where it is at or below 0 °C the road is frozen; the app reads the
 * frost depth as the point where the profile crosses 0 °C below the frozen
 * layer. Frost goes deeper under a ploughed road than in open ground.
 */

/** A string whose top sensor is deeper than this says nothing of the top. */
const TOP_SENSOR_MAX_CM = 30;
/** A point whose newest sample is older than this is not reporting. */
export const MAX_SAMPLE_AGE_MS = 2 * 24 * 60 * 60_000;
export const MAX_POINTS = 500;
const MAX_SENSORS = 80;

/** Frost depth classes, shallowest first; a depth belongs to the first class whose max it does not exceed. */
export const FROST_CLASSES = Object.freeze([
  Object.freeze({ id: 'none', max: 0, color: '#9ccc65' }),
  Object.freeze({ id: 'shallow', max: 30, color: '#4dd0e1' }),
  Object.freeze({ id: 'moderate', max: 80, color: '#448aff' }),
  Object.freeze({ id: 'deep', max: 150, color: '#7c4dff' }),
  Object.freeze({ id: 'very-deep', max: Infinity, color: '#e040fb' }),
]);

/** A WKT "POINT (lon lat)" as [lon, lat], or null outside Sweden. */
export function pointOf(wkt) {
  const match = /POINT\s*Z?\s*\(\s*([-\d.]+)\s+([-\d.]+)/.exec(
    String(wkt ?? ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return lon >= 10 && lon <= 25 && lat >= 55 && lat <= 69.5 ? [lon, lat] : null;
}

/**
 * The frozen layer of a profile ([{depth cm, value °C}], any order):
 * `{ top, bottom, belowSensors }` in cm, or null where nothing is frozen.
 * `top` is where the frost begins (0 unless the surface has thawed above
 * it; null when the string starts too deep to tell, its top sensor already
 * frozen), `bottom` where the profile crosses 0 °C below the deepest frozen
 * sensor, and `belowSensors` says the frost reaches past the deepest one.
 */
export function frozenLayer(profile) {
  const rows = (Array.isArray(profile) ? profile : [])
    .filter((row) => Number.isFinite(row?.depth) && Number.isFinite(row?.value))
    .sort((a, b) => a.depth - b.depth);
  const deepest = rows.findLastIndex((row) => row.value <= 0);
  if (deepest < 0) return null;
  const shallowest = rows.findIndex((row) => row.value <= 0);
  const crossing = (above, below) =>
    above.depth +
    ((below.depth - above.depth) * (0 - above.value)) /
      (below.value - above.value);
  const below = rows[deepest + 1];
  const above = rows[shallowest - 1];
  return {
    top: above
      ? Math.round(crossing(above, rows[shallowest]))
      : rows[0].depth > TOP_SENSOR_MAX_CM
        ? null
        : 0,
    bottom: below
      ? Math.round(crossing(rows[deepest], below))
      : rows[deepest].depth,
    belowSensors: !below,
  };
}

/** The class of a frost depth in cm (0 or null: no frost). */
export function frostClass(depthCm) {
  const depth = Number.isFinite(depthCm) ? depthCm : 0;
  return FROST_CLASSES.find((entry) => depth <= entry.max);
}

export const frostColor = (depthCm) => frostClass(depthCm).color;

const text = (value, max = 80) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Trafikverket's answer as the points that report: `{points, silent}`,
 * `silent` counting the points whose newest sample is too old to show.
 */
export function normalizeFrostDepthSnapshot(response, nowMs = Date.now()) {
  const result = response?.RESPONSE?.RESULT?.[0];
  const list = result?.FrostDepthMeasurepoint;
  if (!Array.isArray(list)) throw new Error('malformed frost depth answer');
  const points = [];
  let silent = 0;
  for (const item of list) {
    if (item?.Deleted === true) continue;
    const id = text(item?.Id, 40);
    const point = pointOf(item?.Geometry?.WGS84);
    if (!id || !point) continue;
    const sampledAt = Date.parse(item?.FrostDepth?.Sample ?? '');
    if (!Number.isFinite(sampledAt) || nowMs - sampledAt > MAX_SAMPLE_AGE_MS) {
      silent += 1;
      continue;
    }
    const profile = (
      Array.isArray(item?.FrostDepth?.Temperature)
        ? item.FrostDepth.Temperature
        : []
    )
      .slice(0, MAX_SENSORS)
      .map((row) => ({
        depth: Number(row?.Depth),
        value: Number(row?.Value),
      }))
      .filter((row) => Number.isFinite(row.depth) && Number.isFinite(row.value))
      .sort((a, b) => a.depth - b.depth);
    // A point without a sensor value reports nothing either.
    if (!profile.length) {
      silent += 1;
      continue;
    }
    // The depth from the sensors' own values; the card shows them rounded.
    const frost = frozenLayer(profile);
    points.push({
      id,
      name: text(item?.Name) ?? id,
      point,
      sampledAt,
      profile: profile.map((row) => ({
        depth: row.depth,
        value: Math.round(row.value * 10) / 10,
      })),
      frost,
      depth: frost ? frost.bottom : 0,
    });
    if (points.length >= MAX_POINTS) break;
  }
  return { points, silent };
}
