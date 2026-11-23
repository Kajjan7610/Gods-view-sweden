/**
 * @module geo/viewExtent
 * @description A view's extent in degrees, `{west, south, east, north}`
 * (east less than west across the antimeridian): checked, clipped to a box
 * around a point, and measured. Swedish fork: the flights feed sends the
 * ground in view, and the server clips it around the look-at point and
 * tells how much of it adsb.lol's discs cover.
 */

const KM_PER_DEGREE = 111.32;
/** Longitudes widen toward the poles no further than at this latitude. */
const WIDEST_LATITUDE = 85;
/** A rectangle this wide spans every longitude: the whole globe, or a pole. */
const EVERY_LONGITUDE = 359.999;
const DEG = Math.PI / 180;

const inRange = (value, limit) =>
  Number.isFinite(value) && value >= -limit && value <= limit;

/** A longitude in [-180, 180). */
const wrapLongitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Degrees east to west, across the antimeridian too. */
const widthOf = ({ west, east }) =>
  east < west ? east + 360 - west : east - west;

/**
 * The extent as given when it is one, else null: an unreadable one, or one
 * that spans every longitude (the whole globe, or a pole in view), whose
 * rectangle says nothing of where the view is.
 * @param {{west: number, south: number, east: number, north: number}|null} extent
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function usableViewExtent(extent) {
  if (!extent) return null;
  const { west, south, east, north } = extent;
  if (![west, east].every((lon) => inRange(lon, 180))) return null;
  if (![south, north].every((lat) => inRange(lat, 90)) || !(north > south))
    return null;
  const width = widthOf(extent);
  if (!(width > 0) || width >= EVERY_LONGITUDE) return null;
  return { west, south, east, north };
}

/**
 * An extent's area on the unit sphere (steradians), for weighing a part of
 * a view against the whole of it.
 * @param {{west: number, south: number, east: number, north: number}} extent
 * @returns {number}
 */
export function viewExtentArea(extent) {
  return (
    widthOf(extent) *
    DEG *
    Math.abs(Math.sin(extent.north * DEG) - Math.sin(extent.south * DEG))
  );
}

/**
 * The part of `extent` within `maxKm` of `around` (north-south, and
 * east-west at its latitude), or null for no usable extent (see
 * usableViewExtent) or one that misses the box.
 * @param {{west: number, south: number, east: number, north: number}|null} extent
 * @param {{latitude: number, longitude: number}|null} around
 * @param {number} maxKm
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function clipViewExtent(extent, around, maxKm) {
  const usable = usableViewExtent(extent);
  if (!usable || !around || !(maxKm > 0)) return null;
  if (!inRange(around.latitude, 90) || !inRange(around.longitude, 180))
    return null;
  const { west, south, north } = usable;
  const reachLat = maxKm / KM_PER_DEGREE;
  const clippedSouth = Math.max(south, around.latitude - reachLat);
  const clippedNorth = Math.min(north, around.latitude + reachLat);
  if (!(clippedNorth > clippedSouth)) return null;
  const widest = Math.min(Math.abs(around.latitude), WIDEST_LATITUDE);
  const reachLon = maxKm / (KM_PER_DEGREE * Math.cos(widest * DEG));
  let from = west;
  let to = west + widthOf(usable);
  if (reachLon < 180) {
    // The point's longitude, unwrapped onto the extent's span.
    const middle = west + ((((around.longitude - west) % 360) + 360) % 360);
    let best = null;
    for (const shift of [0, -360]) {
      const lo = Math.max(from, middle + shift - reachLon);
      const hi = Math.min(to, middle + shift + reachLon);
      if (hi > lo && (!best || hi - lo > best[1] - best[0])) best = [lo, hi];
    }
    if (!best) return null;
    [from, to] = best;
  }
  return {
    west: wrapLongitude(from),
    south: clippedSouth,
    east: wrapLongitude(to),
    north: clippedNorth,
  };
}
