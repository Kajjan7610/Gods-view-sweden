// Swedish fork: Trafikverket's measured traffic, as the queues layer and the
// city dossier read it. Two kinds of rows, both CC0 from the open API:
//  - TravelTimeRoute: stretches of road with the travel time now, the normal
//    one and Trafikverket's own verdict (free flow, heavy, congested,
//    impossible). Mostly Stockholm, a few around Göteborg and Malmö.
//  - TrafficFlow 1.6: one detector per lane with the flow and mean speed of
//    the last minute and, since 2026-11-18, BaselineTraffic: the mean and
//    spread of flow and speed at that time on a normal day. The lanes of one
//    place and direction are read together as one measuring point.
// Pure: no rendering, no i18n.
import { parseWkt, simplifyLine } from '../roadConditions/records.js';

export const MAX_ROUTES = 2000;
export const MAX_SITES = 6000;
/** A measurement older than this says nothing about now. */
export const MAX_AGE_MS = 20 * 60_000;
/** Below this share of the normal speed a point is queued. */
export const QUEUE_RATIO = 0.5;
/** Below this share, and two spreads under normal, a point is slow. */
export const SLOW_RATIO = 0.75;
/**
 * A lane with fewer vehicles than this in a normal hour has no normal speed
 * worth comparing against: a slow car there is not a queue.
 */
export const MIN_NORMAL_FLOW = 120;

/** Trafikverket's verdicts, worst first, with their colours. */
export const QUEUE_STATUSES = Object.freeze([
  'impossible',
  'congested',
  'heavy',
  'freeflow',
  'unknown',
]);
const COLORS = Object.freeze({
  impossible: '#b71c1c',
  congested: '#ff1744',
  heavy: '#ffab00',
  freeflow: '#00c853',
  unknown: '#90a4ae',
});

/** A measuring point's verdict as the stretch verdict it is drawn like. */
const POINT_AS_ROUTE = Object.freeze({
  queue: 'congested',
  slow: 'heavy',
  normal: 'freeflow',
});

/** The colour of a verdict; a point's queue and slow read as congested and heavy. */
export function queueColor(status) {
  return COLORS[POINT_AS_ROUTE[status] ?? status] ?? COLORS.unknown;
}

/** How bad a verdict is: higher is worse; unknown and free flow are 0. */
export function queueRank(status) {
  return (
    {
      impossible: 3,
      congested: 2,
      queue: 2,
      heavy: 1,
      slow: 1,
    }[status] ?? 0
  );
}

const text = (value, max = 80) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};
const number = (value) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : null;
};
const time = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
const round1 = (value) =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const inSweden = ([lon, lat]) =>
  lon >= 10 && lon <= 25 && lat >= 55 && lat <= 69.5;
const distanceKm = ([lon1, lat1], [lon2, lat2]) => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};

/**
 * One TravelTimeRoute as a drawable stretch, or null.
 * @param {object} row
 * @param {number} nowMs
 */
export function normalizeTravelTimeRoute(row, nowMs) {
  if (!row || typeof row !== 'object' || row.Deleted === true) return null;
  const id = text(row.Id, 40);
  const name = text(row.Name, 120);
  const lines = parseWkt(row.Geometry?.WGS84).lines.filter((line) =>
    line.every(inSweden),
  );
  if (!id || !name || !lines.length) return null;
  const measuredAt = time(row.MeasureTime);
  const fresh = measuredAt !== null && nowMs - measuredAt <= MAX_AGE_MS;
  const travelTimeS = number(row.TravelTime);
  // Trafikverket's normal for the hour where it has one, else the time at
  // the signposted speed.
  const normalS =
    number(row.ExpectedFreeFlowTravelTime) ?? number(row.FreeFlowTravelTime);
  const verdict = String(row.TrafficStatus ?? '').toLowerCase();
  const status =
    fresh && QUEUE_STATUSES.includes(verdict) ? verdict : 'unknown';
  return {
    id,
    name,
    status,
    travelTimeS: round1(travelTimeS),
    normalS: round1(normalS),
    delayS:
      fresh && travelTimeS !== null && normalS !== null
        ? Math.max(0, Math.round(travelTimeS - normalS))
        : null,
    speedKmh: fresh ? round1(number(row.Speed)) : null,
    lengthM: Math.round(number(row.Length) ?? 0) || null,
    measuredAt,
    lines: lines.map(simplifyLine),
  };
}

/**
 * A measuring point's verdict from its speed now against the normal one.
 * Without a speed or a normal there is none: an empty road at night reads no
 * speed, which is not a queue. Where the road is all but empty on a normal
 * day, only a normal speed is a verdict.
 */
export function pointStatus({ speed, normalSpeed, speedStdDev, normalFlow }) {
  if (!(speed > 0) || !(normalSpeed > 0)) return 'unknown';
  const ratio = speed / normalSpeed;
  if (ratio >= SLOW_RATIO) return 'normal';
  if (!(normalFlow >= MIN_NORMAL_FLOW)) return 'unknown';
  if (ratio < QUEUE_RATIO) return 'queue';
  if (speed < normalSpeed - 2 * (speedStdDev ?? 0)) return 'slow';
  return 'normal';
}

/** The lanes of one detector site lie a few metres apart. */
export const SAME_PLACE_M = 40;
const CELL_DEG = 0.001;
const cellOf = ([lon, lat]) =>
  `${Math.floor(lon / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`;

/** The place already started within SAME_PLACE_M in the same direction. */
function placeNear(places, point, side) {
  const cx = Math.floor(point[0] / CELL_DEG);
  const cy = Math.floor(point[1] / CELL_DEG);
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1)
      for (const place of places.get(`${cx + dx},${cy + dy}`) ?? [])
        if (
          place.side === side &&
          distanceKm(place.point, point) * 1000 <= SAME_PLACE_M
        )
          return place;
  return null;
}

/**
 * The lanes of TrafficFlow read as measuring points: one per place and
 * direction, flows summed, speeds weighted by flow.
 * @param {object[]} rows
 * @param {number} nowMs
 */
export function normalizeTrafficFlow(rows, nowMs) {
  const places = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.Deleted === true) continue;
    if (String(row.DataQuality ?? '').toLowerCase() === 'bad') continue;
    const measuredAt = time(row.MeasurementTime);
    if (measuredAt === null || nowMs - measuredAt > MAX_AGE_MS) continue;
    const point = parseWkt(row.Geometry?.WGS84).point;
    if (!point || !inSweden(point)) continue;
    const side = text(row.MeasurementSide, 20) ?? '';
    let place = placeNear(places, point, side);
    if (!place) {
      place = {
        point: point.map((v) => Math.round(v * 1e5) / 1e5),
        side,
        siteIds: [],
        lanes: 0,
        flow: 0,
        speedSum: 0,
        speedWeight: 0,
        normalFlow: 0,
        normalSpeedSum: 0,
        normalStdSum: 0,
        normalWeight: 0,
        measuredAt,
        county: number(row.CountyNo),
      };
      const cell = cellOf(point);
      if (!places.has(cell)) places.set(cell, []);
      places.get(cell).push(place);
    }
    const flow = Math.max(0, number(row.VehicleFlowRate) ?? 0);
    const speed = number(row.AverageVehicleSpeed);
    const base = row.BaselineTraffic;
    const normalFlow = Math.max(0, number(base?.Flow?.Mean) ?? 0);
    const normalSpeed = number(base?.Speed?.Mean);
    place.siteIds.push(number(row.SiteId));
    place.lanes += 1;
    place.flow += flow;
    if (speed > 0) {
      // A lane without traffic still has a speed: count it, lightly.
      const weight = Math.max(flow, 1);
      place.speedSum += speed * weight;
      place.speedWeight += weight;
    }
    if (normalSpeed > 0) {
      const weight = Math.max(normalFlow, 1);
      place.normalFlow += normalFlow;
      place.normalSpeedSum += normalSpeed * weight;
      place.normalStdSum +=
        Math.max(0, number(base?.Speed?.StdDev) ?? 0) * weight;
      place.normalWeight += weight;
    }
    place.measuredAt = Math.max(place.measuredAt, measuredAt);
  }
  const points = [];
  for (const place of [...places.values()].flat()) {
    const ids = place.siteIds.filter(Number.isFinite).sort((a, b) => a - b);
    if (!ids.length) continue;
    const speed = place.speedWeight ? place.speedSum / place.speedWeight : null;
    const normalSpeed = place.normalWeight
      ? place.normalSpeedSum / place.normalWeight
      : null;
    const speedStdDev = place.normalWeight
      ? place.normalStdSum / place.normalWeight
      : null;
    const normalFlow = place.normalWeight ? Math.round(place.normalFlow) : null;
    points.push({
      id: `${ids[0]}`,
      point: place.point,
      side: place.side || null,
      lanes: place.lanes,
      flow: Math.round(place.flow),
      normalFlow,
      speed: round1(speed),
      normalSpeed: round1(normalSpeed),
      speedStdDev: round1(speedStdDev),
      status: pointStatus({ speed, normalSpeed, speedStdDev, normalFlow }),
      measuredAt: place.measuredAt,
      county: place.county,
    });
  }
  return points
    .sort((a, b) => queueRank(b.status) - queueRank(a.status))
    .slice(0, MAX_SITES);
}

/**
 * Trafikverket's answer to the two queries as the layer and the dossier use
 * it: the stretches, worst first, and the measuring points.
 * @param {object} payload
 * @param {number} nowMs
 */
export function normalizeQueueSnapshot(payload, nowMs) {
  const results = Array.isArray(payload?.RESPONSE?.RESULT)
    ? payload.RESPONSE.RESULT
    : [];
  const routes = (
    Array.isArray(results[0]?.TravelTimeRoute) ? results[0].TravelTimeRoute : []
  )
    .map((row) => normalizeTravelTimeRoute(row, nowMs))
    .filter(Boolean)
    .sort(
      (a, b) =>
        queueRank(b.status) - queueRank(a.status) ||
        (b.delayS ?? 0) - (a.delayS ?? 0),
    )
    .slice(0, MAX_ROUTES);
  const points = normalizeTrafficFlow(results[1]?.TrafficFlow, nowMs);
  return { routes, points };
}

/** A stretch's middle vertex: where it is, for "near the town". */
const middleOf = (route) => {
  const line = route.lines[0];
  return line[Math.floor(line.length / 2)];
};

/**
 * The queues around a town for the city dossier, or null where Trafikverket
 * measures no stretch and no point near it.
 * @param {{routes: object[], points: object[]}} snapshot
 * @param {{latitude: number, longitude: number}} town
 * @param {{radiusKm?: number, max?: number}} [options]
 */
export function queuesNear(snapshot, town, { radiusKm = 15, max = 4 } = {}) {
  if (!snapshot) return null;
  const at = [town.longitude, town.latitude];
  const near = (point) => distanceKm(point, at) <= radiusKm;
  const routes = (snapshot.routes ?? []).filter(
    (route) => route.status !== 'unknown' && near(middleOf(route)),
  );
  const points = (snapshot.points ?? []).filter(
    (point) => point.status !== 'unknown' && near(point.point),
  );
  if (!routes.length && !points.length) return null;
  return {
    routes: routes.length,
    points: points.length,
    pointsQueued: points.filter((point) => point.status === 'queue').length,
    items: routes
      .filter((route) => queueRank(route.status) > 0)
      .slice(0, max)
      .map((route) => ({
        name: route.name,
        status: route.status,
        delayS: route.delayS,
        speedKmh: route.speedKmh,
        lengthM: route.lengthM,
      })),
  };
}
