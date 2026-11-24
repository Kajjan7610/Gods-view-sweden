/**
 * @module transitRouteShapes
 * @description Swedish fork: route shapes for the Transit layer's Trafiklab
 * vehicles. The server reads each operator's static GTFS `shapes.txt` (CC0
 * 1.0), simplifies every shape and serves it, from its cache only, as an
 * encoded polyline (`/api/transit/shapes`, server/providers/trafiklabShapes.js);
 * the layer draws a vehicle along its trip's shape between two position
 * reports where every rule in `routeShapeBetween` holds, and in a straight
 * line otherwise (src/layers/transit/routeShapes.js).
 *
 * The polyline format is Google's encoded polyline at five decimals (about a
 * metre): latitude and longitude, each the difference from the point before.
 *
 * `followRouteShape` and `sampleRouteShapePosition` run on every frame for a
 * vehicle drawn along a shape: they read precomputed arrays, allocate nothing
 * and run no trigonometry.
 *
 * Pure: no Cesium, no DOM, no network.
 */

import { projectOnPath } from './railPaths.js';

/** A shape id the server serves: printable ASCII, no comma (the separator). */
export const ROUTE_SHAPE_ID_PATTERN = /^[\x21-\x2b\x2d-\x7e]{1,64}$/;
/** Shape ids one request may name. */
export const ROUTE_SHAPES_MAX_IDS = 32;
/** Points one shape may have, as the server simplifies it and the client reads it. */
export const ROUTE_SHAPE_MAX_POINTS = 4000;
/** A report farther than this from the shape is off it: a detour (m). */
export const ROUTE_SHAPE_MAX_OFFSET_M = 40;
/** The way along the shape may be at most this many times the straight one. */
export const ROUTE_SHAPE_MAX_DETOUR = 3;
/** Below this straight distance between two reports a vehicle is not moving (m). */
export const ROUTE_SHAPE_MIN_TRAVEL_M = 2;
/** Longest step between two drawn points, as the straight steps (m). */
export const ROUTE_SHAPE_STEP_M = 25;
/**
 * Another pass of the shape near a report (a loop's two ends, the way out and
 * the way back) counts as where the report may be only when it is at most
 * this much farther from it than the nearest pass (m): two lanes of one
 * street, not two streets.
 */
export const ROUTE_SHAPE_PASS_SLACK_M = 15;
/**
 * A segment shorter than this gives no course, as transit movement's own
 * `courseMinTravelM` (m); used when an entry's track names none.
 */
const COURSE_MIN_TRAVEL_M = 12;

/** Metres per degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_320;
/** Decimals the polyline keeps: five, about a metre. */
const PRECISION = 1e5;
/** A chained report is looked for this near where the last segment ended (m). */
const CHAIN_WINDOW_M = 2 * ROUTE_SHAPE_MAX_OFFSET_M;

/** Longitude difference wrapped into (-180, 180]. */
function wrapLon(delta) {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/** Flat-earth metres between two lat/lon points, as transit movement measures. */
function metres(a, b) {
  const dLat = (b.lat - a.lat) * M_PER_DEG;
  const dLon =
    wrapLon(b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Append one signed polyline value to `codes`, as character codes. */
function pushValue(codes, value) {
  let rest = value < 0 ? ~(value << 1) : value << 1;
  while (rest >= 0x20) {
    codes.push((0x20 | (rest & 0x1f)) + 63);
    rest >>>= 5;
  }
  codes.push(rest + 63);
}

/**
 * Encode a shape as a polyline, rounded to five decimals. A point that rounds
 * onto the one before is left out.
 * @param {ArrayLike<number>} coords `[lat, lon, lat, lon, ...]`.
 * @returns {string} '' when fewer than two distinct points remain.
 */
export function encodeRouteShape(coords) {
  const codes = [];
  let lastLat = 0;
  let lastLon = 0;
  let points = 0;
  for (let i = 0; i + 1 < (coords?.length ?? 0); i += 2) {
    const lat = Math.round(Number(coords[i]) * PRECISION);
    const lon = Math.round(Number(coords[i + 1]) * PRECISION);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 * PRECISION ||
      Math.abs(lon) > 180 * PRECISION
    )
      return '';
    if (points > 0 && lat === lastLat && lon === lastLon) continue;
    pushValue(codes, lat - lastLat);
    pushValue(codes, lon - lastLon);
    lastLat = lat;
    lastLon = lon;
    points += 1;
  }
  if (points < 2) return '';
  let text = '';
  for (let i = 0; i < codes.length; i += 8192)
    text += String.fromCharCode(...codes.slice(i, i + 8192));
  return text;
}

/**
 * Decode a polyline from `/api/transit/shapes`.
 * @param {string} text
 * @param {number} [maxPoints]
 * @returns {number[]|null} `[lat, lon, lat, lon, ...]`, or null when the text
 *   is not a polyline of 2..maxPoints points on the globe.
 */
export function decodeRouteShape(text, maxPoints = ROUTE_SHAPE_MAX_POINTS) {
  if (typeof text !== 'string' || !text) return null;
  const coords = [];
  const values = [0, 0];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < text.length) {
    for (let v = 0; v < 2; v++) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        if (i >= text.length || shift > 25) return null;
        byte = text.charCodeAt(i++) - 63;
        if (byte < 0 || byte > 63) return null;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      values[v] = result & 1 ? ~(result >>> 1) : result >>> 1;
    }
    lat += values[0];
    lon += values[1];
    if (Math.abs(lat) > 90 * PRECISION || Math.abs(lon) > 180 * PRECISION)
      return null;
    if (coords.length >= 2 * maxPoints) return null;
    coords.push(lat / PRECISION, lon / PRECISION);
  }
  return coords.length >= 4 ? coords : null;
}

/** The shape edge whose arc range holds `s`, clamped to the shape. */
function edgeAt(path, s) {
  const arc = path.s;
  let lo = 0;
  let hi = path.n - 2;
  if (!(s > arc[0])) return 0;
  if (s >= arc[hi + 1]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The shape's own direction along edge `e` (deg), NaN for an edge of no length. */
function edgeBearing(path, e) {
  const dx = path.x[e + 1] - path.x[e];
  const dy = path.y[e + 1] - path.y[e];
  return dx === 0 && dy === 0
    ? NaN
    : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/**
 * The latest place in [fromS, toS) where the shape passes nearest a point and
 * within `maxOffsetM` of it, or null. A pass is the foot of the point on an
 * edge, or the corner between two edges the point lies beyond both of.
 * @returns {{s: number, offsetM: number, index: number}|null}
 */
function latestPassNear(path, lat, lon, fromS, toS, maxOffsetM) {
  const { x, y, s } = path;
  const px = wrapLon(lon - path.lon0) * path.kx;
  const py = (lat - path.lat0) * path.ky;
  const along = (i) => {
    const dx = x[i + 1] - x[i];
    const dy = y[i + 1] - y[i];
    const length2 = dx * dx + dy * dy;
    return length2 > 0 ? ((px - x[i]) * dx + (py - y[i]) * dy) / length2 : NaN;
  };
  const limit2 = maxOffsetM * maxOffsetM;
  for (let i = edgeAt(path, toS); i >= 0 && s[i + 1] > fromS; i--) {
    const t = along(i);
    let arc;
    let qx;
    let qy;
    if (t > 0 && t < 1) {
      arc = s[i] + (s[i + 1] - s[i]) * t;
      qx = x[i] + (x[i + 1] - x[i]) * t;
      qy = y[i] + (y[i + 1] - y[i]) * t;
    } else if (t <= 0 && (i === 0 || !(along(i - 1) < 1))) {
      arc = s[i];
      qx = x[i];
      qy = y[i];
    } else continue;
    if (!(arc < toS) || arc < fromS) continue;
    const d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
    if (d2 <= limit2) return { s: arc, offsetM: Math.sqrt(d2), index: i };
  }
  return null;
}

/** The point at arc `v` on the shape's edge `e`, into `out`. */
function pointOnEdge(path, e, v, out) {
  const s = path.s;
  const span = s[e + 1] - s[e];
  const t = span > 0 ? Math.max(0, Math.min(1, (v - s[e]) / span)) : 0;
  out.lat = path.lat[e] + (path.lat[e + 1] - path.lat[e]) * t;
  out.lon = path.lon[e] + wrapLon(path.lon[e + 1] - path.lon[e]) * t;
  return out;
}

/** Arc lengths from `from` to `to`: every shape vertex between, in steps of at most `stepM`. */
function arcsBetween(path, from, to, stepM) {
  const arcs = [from.s];
  let previous = from.s;
  const reach = (target) => {
    const length = target - previous;
    const parts = Number.isFinite(stepM)
      ? Math.max(1, Math.ceil(length / stepM))
      : 1;
    for (let k = 1; k < parts; k++) arcs.push(previous + (length * k) / parts);
    arcs.push(target);
    previous = target;
  };
  for (let i = from.index + 1; i <= to.index; i++)
    if (path.s[i] > previous && path.s[i] < to.s) reach(path.s[i]);
  reach(to.s);
  return arcs;
}

/**
 * The points a vehicle is drawn through between two reports along its trip's
 * route shape, or null when it is drawn in a straight line between them.
 *
 * Every rule must hold, else null: both reports lie within
 * ROUTE_SHAPE_MAX_OFFSET_M of the shape (a report off it is a detour); the
 * later one lies further along it, never back; the way along it is at most
 * ROUTE_SHAPE_MAX_DETOUR times the straight distance, and `plausible` accepts
 * it in the time between the two. The path starts on the earlier report and
 * ends on the later one, never past it: the points between follow the shape,
 * moved by the two reports' own offsets from it, blended along the way.
 *
 * `fractions` are each point's share of the way along the shape, which is
 * the share of the time between the reports at which the vehicle is drawn
 * there; `courses` the course from each point to the next.
 *
 * @param {object} path The shape, from createRailPath.
 * @param {{t: number, lat: number, lon: number}} a The earlier report.
 * @param {{t: number, lat: number, lon: number}} b The later report.
 * @param {{maxSteps?: number, hintS?: number, uid?: number,
 *   plausible?: (metres: number, seconds: number) => boolean}} [options]
 *   `maxSteps` caps the steps (null when even the shape's own corners do not
 *   fit); `hintS`, where the earlier report lay along the shape as the
 *   segment before ended; `uid` names the shape.
 * @returns {{lat: Float64Array, lon: Float64Array, fractions: Float64Array,
 *   courses: Float64Array, speedMps: number, sA: number, sB: number,
 *   uid: number}|null}
 */
export function routeShapeBetween(
  path,
  a,
  b,
  { maxSteps = Infinity, hintS = NaN, uid = 0, plausible = null } = {},
) {
  if (!path || !a || !b) return null;
  const seconds = (b.t - a.t) / 1000;
  const straight = metres(a, b);
  if (!(seconds > 0) || !(straight >= ROUTE_SHAPE_MIN_TRAVEL_M)) return null;
  let from = Number.isFinite(hintS)
    ? projectOnPath(path, a.lat, a.lon, hintS, CHAIN_WINDOW_M)
    : null;
  if (!from || !(from.offsetM <= ROUTE_SHAPE_MAX_OFFSET_M))
    from = projectOnPath(path, a.lat, a.lon);
  if (!from || !(from.offsetM <= ROUTE_SHAPE_MAX_OFFSET_M)) return null;
  // Only as far along as the detour rule could allow, either way: a far
  // part of the same shape (a loop, the way back) is never the later report.
  const to = projectOnPath(
    path,
    b.lat,
    b.lon,
    from.s,
    ROUTE_SHAPE_MAX_DETOUR * straight + 2 * ROUTE_SHAPE_MAX_OFFSET_M,
  );
  if (!to || !(to.offsetM <= ROUTE_SHAPE_MAX_OFFSET_M)) return null;
  // Where the shape passes the earlier report more than once (the way out
  // and the way back of a loop), the pass nearest the later report: the
  // shortest way between them, never the loop driven again.
  const later = latestPassNear(
    path,
    a.lat,
    a.lon,
    from.s,
    to.s,
    Math.min(ROUTE_SHAPE_MAX_OFFSET_M, from.offsetM + ROUTE_SHAPE_PASS_SLACK_M),
  );
  if (later && later.s > from.s) from = later;
  const arc = to.s - from.s;
  if (!(arc > 0) || arc > ROUTE_SHAPE_MAX_DETOUR * straight) return null;
  if (plausible && !plausible(arc, seconds)) return null;
  if (to.index - from.index > maxSteps) return null;
  let arcs = arcsBetween(path, from, to, ROUTE_SHAPE_STEP_M);
  // Too many for the room left: the shape's own corners only.
  if (arcs.length - 1 > maxSteps) arcs = arcsBetween(path, from, to, Infinity);
  if (arcs.length - 1 > maxSteps) return null;

  const m = arcs.length - 1;
  const lat = new Float64Array(m + 1);
  const lon = new Float64Array(m + 1);
  const fractions = new Float64Array(m + 1);
  const courses = new Float64Array(m + 1);
  const base = { lat: 0, lon: 0 };
  pointOnEdge(path, from.index, from.s, base);
  const fromLat = a.lat - base.lat;
  const fromLon = wrapLon(a.lon - base.lon);
  pointOnEdge(path, to.index, to.s, base);
  const toLat = b.lat - base.lat;
  const toLon = wrapLon(b.lon - base.lon);
  // A course per step, worked out here once (a frame only reads it): the
  // shape's own direction along the edge the step lies on, not the jitter
  // between the reports. An edge of no length takes the course before it;
  // leading ones, the first there is.
  let first = -1;
  let e = from.index;
  for (let k = 0; k <= m; k++) {
    const v = arcs[k];
    while (e < path.n - 2 && path.s[e + 1] < v) e++;
    pointOnEdge(path, e, v, base);
    const u = (v - from.s) / arc;
    fractions[k] = u;
    lat[k] = base.lat + fromLat + (toLat - fromLat) * u;
    lon[k] = base.lon + fromLon + (toLon - fromLon) * u;
    if (k > 0 && Math.abs(lon[k] - lon[k - 1]) > 180) return null;
    if (k === 0) continue;
    // Step k - 1 ends at this point, on edge `e`.
    const bearing = edgeBearing(path, e);
    if (Number.isFinite(bearing)) {
      courses[k - 1] = bearing;
      if (first < 0) first = k - 1;
    } else courses[k - 1] = k > 1 ? courses[k - 2] : NaN;
  }
  for (let k = 0; k < first; k++) courses[k] = courses[first];
  courses[m] = courses[m - 1];
  // Exactly on the two reports.
  lat[0] = a.lat;
  lon[0] = a.lon;
  lat[m] = b.lat;
  lon[m] = b.lon;
  fractions[0] = 0;
  fractions[m] = 1;
  return {
    lat,
    lon,
    fractions,
    courses,
    speedMps: arc / seconds,
    sA: from.s,
    sB: to.s,
    uid,
  };
}

/**
 * The step of a shaped display path that holds the sample's playback
 * fraction. The path keeps the last step found, so a frame walks at most a
 * step or two. Objects in, an index out: no double crosses the call, which
 * would box it on every frame.
 * @param {{shape: {fractions: Float64Array}, cursor: number}} path
 * @param {{fraction: number}} sample
 * @returns {number}
 */
function stepAt(path, sample) {
  const fractions = path.shape.fractions;
  const last = fractions.length - 2;
  const f = sample.fraction;
  let i = path.cursor;
  if (i > last) i = last;
  while (i > 0 && fractions[i] > f) i--;
  while (i < last && fractions[i + 1] <= f) i++;
  path.cursor = i;
  return i;
}

/** How a segment sets the course (`routeShapeTurn`). */
const TURN_PLAYBACK = 0; // left as playback made it
const TURN_ALONG = 1; // the shape's direction at each step
const TURN_ARRIVAL = 2; // the way the vehicle arrived along its shape

/**
 * The fields `followRouteShape` keeps on a vehicle, all set at once so the
 * frame reads one shape of object: the segment last entered (its two report
 * seqs), its shaped path (`routeShapePath`, null for none) and how it sets
 * the course (`routeShapeTurn`); the reports from the one the vehicle
 * arrived at along its shape to the last it has stood at since
 * (`routeShapeHeldAt` .. `routeShapeHeldTo`) and the way it arrived
 * (`routeShapeCourse`); whether it is drawn along its shape
 * (`routeShapeDrawn`).
 * @param {object} entry
 */
export function initRouteShapeFrame(entry) {
  if (entry.routeShapeAt !== undefined) return;
  entry.routeShapeAt = -1;
  entry.routeShapeTo = -1;
  entry.routeShapePath = null;
  entry.routeShapeTurn = TURN_PLAYBACK;
  entry.routeShapeHeldAt = -1;
  entry.routeShapeHeldTo = -1;
  entry.routeShapeCourse = NaN;
  entry.routeShapeDrawn = false;
}

/**
 * Once per segment playback enters (and again after each preparation of the
 * vehicle's paths, which forgets it: `routeShapeAt = -1`): its shaped path,
 * and how it sets the course. A segment shorter than the track's
 * `courseMinTravelM` gives no course, as playback's own: a vehicle standing
 * at a report it reached along its shape, held there or creeping on, keeps
 * facing the way it arrived, and is still drawn along its shape, until it
 * moves on in a straight line.
 */
function enterSegment(entry, sample) {
  // Playback's own straight distance between the two reports.
  const chordM = (sample.segmentSpeedMps * (sample.toT - sample.fromT)) / 1000;
  const moved =
    chordM >= (entry.track?.policy?.courseMinTravelM ?? COURSE_MIN_TRAVEL_M);
  const found = entry.displayPaths?.get(sample.fromSeq);
  const path =
    found !== undefined &&
    found.shape !== undefined &&
    found.toSeq === sample.toSeq
      ? found
      : null;
  // Standing, or creeping, since it arrived along its shape.
  const arrived =
    !moved &&
    entry.routeShapeHeldAt >= 0 &&
    sample.fromSeq >= entry.routeShapeHeldAt &&
    sample.fromSeq <= entry.routeShapeHeldTo;
  if (arrived && sample.toSeq > entry.routeShapeHeldTo)
    entry.routeShapeHeldTo = sample.toSeq;
  if (path !== null && moved) {
    const courses = path.shape.courses;
    entry.routeShapeCourse = courses[courses.length - 1];
    entry.routeShapeHeldAt = path.toSeq;
    entry.routeShapeHeldTo = path.toSeq;
  }
  entry.routeShapeAt = sample.fromSeq;
  entry.routeShapeTo = sample.toSeq;
  entry.routeShapePath = path;
  entry.routeShapeTurn =
    path !== null && moved
      ? TURN_ALONG
      : arrived
        ? TURN_ARRIVAL
        : TURN_PLAYBACK;
  if (path !== null || arrived) entry.routeShapeDrawn = true;
  // At a report with no segment: the last segment's answer stands.
  else if (sample.fromSeq !== sample.toSeq) entry.routeShapeDrawn = false;
}

/**
 * Per frame, after playback has advanced: a vehicle drawn along its route
 * shape between two reports is where its shaped path puts it, facing the
 * shape's direction there (or the way it arrived, while it stands) and
 * moving at its speed along it. Its sample's latitude, longitude, course and
 * speed are rewritten; any other sample is left as playback made it, but for
 * the course of one standing where it arrived along its shape. What a
 * segment needs is worked out once, as playback enters it (enterSegment); a
 * frame only interpolates.
 * @param {object} entry A vehicle `initRouteShapeFrame` has prepared.
 * @returns {boolean} Whether the sample was placed on a shaped path.
 */
export function followRouteShape(entry) {
  const sample = entry.sample;
  if (
    entry.routeShapeAt !== sample.fromSeq ||
    entry.routeShapeTo !== sample.toSeq
  )
    enterSegment(entry, sample);
  const turn = entry.routeShapeTurn;
  const path = entry.routeShapePath;
  if (path === null) {
    if (turn === TURN_ARRIVAL) sample.segmentCourseDeg = entry.routeShapeCourse;
    return false;
  }
  const shape = path.shape;
  const fractions = shape.fractions;
  const i = stepAt(path, sample);
  // Scalar interpolation stays in this frame function (see stepAt).
  const span = fractions[i + 1] - fractions[i];
  let t = span > 0 ? (sample.fraction - fractions[i]) / span : 0;
  if (!(t >= 0)) t = 0;
  else if (t > 1) t = 1;
  const lat = shape.lat;
  const lon = shape.lon;
  sample.lat = lat[i] + (lat[i + 1] - lat[i]) * t;
  sample.lon = lon[i] + (lon[i + 1] - lon[i]) * t;
  sample.segmentSpeedMps = shape.speedMps;
  if (turn === TURN_ALONG) sample.segmentCourseDeg = shape.courses[i];
  else if (turn === TURN_ARRIVAL)
    sample.segmentCourseDeg = entry.routeShapeCourse;
  return true;
}

/**
 * Per frame: the drawn position on a shaped display path at the sample's
 * playback fraction, into `out` (ECEF, from the path's prepared positions).
 * @param {{positions: {x: number, y: number, z: number}[],
 *   shape: {fractions: Float64Array}, cursor: number}} path
 * @param {{fraction: number}} sample
 * @param {{x: number, y: number, z: number}} out
 * @returns {{x: number, y: number, z: number}} `out`.
 */
export function sampleRouteShapePosition(path, sample, out) {
  const fractions = path.shape.fractions;
  const i = stepAt(path, sample);
  const span = fractions[i + 1] - fractions[i];
  let t = span > 0 ? (sample.fraction - fractions[i]) / span : 0;
  if (!(t >= 0)) t = 0;
  else if (t > 1) t = 1;
  const a = path.positions[i];
  const b = path.positions[i + 1];
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}
