/**
 * Swedish fire stations from Myndigheten för civilt försvar (MCF, formerly
 * MSB): pure parsing shared by the server proxy and the layer. No Cesium, no
 * Node built-ins.
 *
 * MCF publishes every station of the municipal rescue services as an INSPIRE
 * OGC API Features collection (US_fireStation), some 840 points. Stations
 * carry no name: each has a position, which MCF says varies in accuracy, and
 * its highest form of readiness. The proxy names the nearest municipal seat.
 */

/** MCF's readiness forms, strongest first, with their colour. */
export const READINESS_CLASSES = Object.freeze(
  [
    ['full-time', 'Heltid', '#e53935'],
    ['retained-officer', 'Deltid (RiB) med FIP/FIB', '#fb8c00'],
    ['retained', 'Deltid (RiB) utan FIP/FIB', '#fdd835'],
    ['rescue-post', 'Kommunalt räddningsvärn', '#90a4ae'],
  ].map(([id, source, color]) => Object.freeze({ id, source, color })),
);
export const UNKNOWN_COLOR = '#bdbdbd';

const BY_SOURCE = new Map(
  READINESS_CLASSES.map((entry) => [entry.source, entry]),
);

export function readinessClass(id) {
  return READINESS_CLASSES.find((entry) => entry.id === id) || null;
}

export function readinessColor(id) {
  return readinessClass(id)?.color || UNKNOWN_COLOR;
}

const RAD = Math.PI / 180;
function distanceKm([lon1, lat1], [lon2, lat2]) {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * The nearest municipal seat to a point.
 * @param {[number, number]} point Longitude, latitude.
 * @param {ReadonlyArray<[string, string, string, number, number]>} seats
 *   Rows of [code, municipality, seat if named differently, lon, lat].
 */
export function nearestSeat(point, seats) {
  let best = null;
  for (const [, municipality, seat, lon, lat] of seats) {
    const km = distanceKm(point, [lon, lat]);
    if (!best || km < best.km) best = { name: seat || municipality, km };
  }
  return best && { name: best.name, km: Math.round(best.km) };
}

/**
 * One station, or null without a place in Sweden.
 * @param {object} feature A GeoJSON Point feature from MCF.
 * @param {ReadonlyArray} seats Municipal seats for {@link nearestSeat}.
 */
export function normalizeFireStation(feature, seats = []) {
  const [lon, lat] = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates.map(Number)
    : [];
  const props = feature?.properties || {};
  const id = String(props.inspireid ?? feature?.id ?? '')
    .replace(/[^\w-]/g, '')
    .slice(0, 40);
  if (
    !id ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 54 ||
    lat > 70 ||
    lon < 9 ||
    lon > 25
  )
    return null;
  const point = [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
  const name =
    typeof props.name === 'string' && props.name.trim()
      ? props.name.trim().slice(0, 80)
      : null;
  return {
    id,
    point,
    name,
    readiness: BY_SOURCE.get(props.hogstaberedskapsform)?.id ?? null,
    near: seats.length ? nearestSeat(point, seats) : null,
  };
}

/**
 * Every station, strongest readiness first.
 * @param {object} payload MCF's FeatureCollection.
 * @param {ReadonlyArray} seats Municipal seats for {@link nearestSeat}.
 */
export function normalizeFireStations(payload, seats = []) {
  if (!Array.isArray(payload?.features))
    throw new Error('Malformed fire station collection');
  const order = (row) =>
    row.readiness
      ? READINESS_CLASSES.findIndex((entry) => entry.id === row.readiness)
      : READINESS_CLASSES.length;
  const seen = new Set();
  return payload.features
    .map((feature) => normalizeFireStation(feature, seats))
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id))
    .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}
