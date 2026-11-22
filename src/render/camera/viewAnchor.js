import { rayEllipsoid, toLonLatH } from '../../geo/ellipsoid.js';
import { rectangleCenter } from '../../geo/rectangle.js';
import { toDegrees, toRadians } from '../../geo/vector.js';
import { findCamera } from '../rendererOf.js';

/** The middle of a degree rectangle, across the antimeridian too. */
function degreesCentre(rect) {
  const { lon, lat } = rectangleCenter({
    west: toRadians(rect.west),
    south: toRadians(rect.south),
    east: toRadians(rect.east),
    north: toRadians(rect.north),
  });
  return { lon: toDegrees(lon), lat: toDegrees(lat) };
}

/**
 * Whether a degree rectangle spans every longitude (the whole globe, or a
 * pole in view): its middle says nothing of where the view is.
 */
function spansEveryLongitude({ west, east }) {
  const width = east < west ? east + 360 - west : east - west;
  return width >= 359.999;
}

/** Where the ray comes nearest the earth's centre, ahead of its origin. */
function closestApproach(origin, unit) {
  const t = Math.max(
    0,
    -(origin.x * unit.x + origin.y * unit.y + origin.z * unit.z),
  );
  return {
    x: origin.x + t * unit.x,
    y: origin.y + t * unit.y,
    z: origin.z + t * unit.z,
  };
}

/**
 * Degrees at the centre of the current view (the look-at point), or null
 * before the camera settles. It is where the eye's line of sight (the ray
 * through the screen centre) meets the ellipsoid; when the ray passes the
 * globe by, the ground under its closest approach to the earth's centre
 * (looking past the limb, the horizon in the middle of the screen); with
 * the eye below the ellipsoid (street level where the geoid lies under it),
 * whose line of sight starts inside, the point under the eye. A camera port
 * without a position falls back to the middle of its view rectangle, never
 * one that spans every longitude, else the point under the eye. Reads the
 * camera port only, so it works in every renderer. The GNSS layer and the
 * flights feed ask around it.
 * @param {object} viewer
 * @returns {{latitude: number, longitude: number}|null}
 */
export function viewAnchor(viewer) {
  const camera = findCamera(viewer);
  if (!camera) return null;
  const pose = camera.pose();
  // No ground point under the eye (an eye at the earth's centre): unsettled.
  if (!Number.isFinite(pose?.lat) || !Number.isFinite(pose?.lon)) return null;
  const origin = pose.position;
  const direction = pose.direction;
  const length = direction
    ? Math.hypot(direction.x, direction.y, direction.z)
    : 0;
  let at = null;
  if (Number.isFinite(pose.height) && pose.height < 0) {
    at = pose;
  } else if (origin && length > 0) {
    const unit = {
      x: direction.x / length,
      y: direction.y / length,
      z: direction.z / length,
    };
    const hit = rayEllipsoid({ origin, direction: unit });
    at = toLonLatH(hit ?? closestApproach(origin, unit));
  }
  if (!at) {
    const rectangle = camera.viewRectangle?.();
    at =
      rectangle && !spansEveryLongitude(rectangle)
        ? degreesCentre(rectangle)
        : pose;
  }
  const latitude = at?.lat;
  const longitude = at?.lon;
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}
