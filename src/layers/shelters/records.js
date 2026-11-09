/**
 * Swedish civil-defence shelters from Myndigheten för civilt försvar (MCF):
 * pure parsing and queries shared by the server proxy and the layer. No
 * Cesium, no Node built-ins.
 *
 * MCF publishes every shelter as an INSPIRE OGC API Features collection
 * (US_civilProtectionSite), some 63,000 points with 6.8 million places, free
 * of conditions. Each has its shelter number, the property it stands on
 * (kvarter and number, not a street address), its places and whether it is
 * temporarily restricted. The proxy keeps them all and answers for the view.
 */

/** Shelter states, ready first, with their colour. */
export const SHELTER_STATES = Object.freeze(
  [
    ['ready', '#64ffda'],
    ['limited', '#ffb74d'],
  ].map(([id, color]) => Object.freeze({ id, color })),
);

export function shelterColor(row) {
  return SHELTER_STATES.find(
    (entry) => entry.id === (row?.limited ? 'limited' : 'ready'),
  ).color;
}

const text = (value, max) =>
  typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, max)
    : null;

/**
 * One shelter, or null without a place in Sweden.
 * @param {object} feature A GeoJSON (Multi)Point feature from MCF.
 */
export function normalizeShelter(feature) {
  const geometry = feature?.geometry;
  const coordinates =
    geometry?.type === 'MultiPoint'
      ? geometry.coordinates?.[0]
      : geometry?.coordinates;
  const [lon, lat] = Array.isArray(coordinates) ? coordinates.map(Number) : [];
  const props = feature?.properties || {};
  const id = String(props.id ?? props.inspireid ?? '')
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
  const places = Number(props.numberofoccupants);
  return {
    id,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    number: text(props.name, 20),
    property: text(props.additionallocationdescription, 80),
    places: Number.isFinite(places) && places > 0 ? Math.round(places) : null,
    // MCF status 7: "Tillfällig begränsning".
    limited: Number(props.status) === 7,
    // Variant 2: "Special".
    special: Number(props.variantid) === 2,
  };
}

/** Every shelter in the collection pages, without duplicates. */
export function normalizeShelters(features) {
  if (!Array.isArray(features)) throw new Error('Malformed shelter collection');
  const seen = new Set();
  return features
    .map(normalizeShelter)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id));
}

const RAD = Math.PI / 180;
/** Great-circle metres between two [lon, lat] points. */
export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A view wider than this (degrees) is a country, not a neighbourhood. */
export const SHELTERS_MAX_SPAN_DEG = 3;

const E4 = 1e4;
/** One axis of a view in 1e-4 degrees, at most `span` wide about `mid`. */
function clipAxis(low, high, mid, span) {
  if (high - low <= span) return [low, high];
  const from = Math.max(low, mid - span / 2);
  const to = Math.min(high, mid + span / 2);
  // A centre outside the view (the camera's own place, when the middle of
  // the screen shows sky) gets the box around itself.
  return from < to ? [from, to] : [mid - span / 2, mid + span / 2];
}

/**
 * The view box cut to at most SHELTERS_MAX_SPAN_DEG a side about the centre:
 * a tilted camera sees to the horizon, and the shelters wanted are the ones
 * nearest the centre. Edges come out at 1e-4 degrees, so a cut box is never
 * a hair wider than the span.
 * @param {number[]} bbox [west, south, east, north].
 * @param {number[]} center [lon, lat].
 */
export function clipViewBox(bbox, center, span = SHELTERS_MAX_SPAN_DEG) {
  const [west, south, east, north, lon, lat, max] = [
    ...bbox,
    ...center,
    span,
  ].map((value) => Math.round(value * E4));
  const [w, e] = clipAxis(west, east, lon, max);
  const [s, n] = clipAxis(south, north, lat, max);
  return [w, s, e, n].map((value) => value / E4);
}

/**
 * The shelters in a box: how many and their places, and the nearest `limit`
 * to the centre, nearest first, each with its distance.
 * @param {object[]} rows Normalized shelters.
 * @param {{bbox: number[], center: number[], limit?: number}} query
 *   `bbox` is [west, south, east, north]; `center` is [lon, lat].
 */
export function sheltersInView(rows, { bbox, center, limit = 1500 }) {
  const [west, south, east, north] = bbox;
  let total = 0;
  let places = 0;
  const inside = [];
  for (const row of rows) {
    const [lon, lat] = row.point;
    if (lon < west || lon > east || lat < south || lat > north) continue;
    total += 1;
    places += row.places || 0;
    inside.push(row);
  }
  const shown = inside
    .map((row) => ({
      ...row,
      distance: Math.round(distanceMeters(center, row.point)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, limit));
  return { total, places, shelters: shown };
}
