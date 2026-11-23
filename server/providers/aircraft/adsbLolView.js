// Swedish fork: the flights of the whole view from adsb.lol, whose area
// queries are discs of 250 nm and which has no box to ask for. The disc
// around the look-at point is read as before (opensky.js); the rest of the
// view is covered by outer discs on a fixed lattice, so that every view, and
// every user, asks for the same few discs:
// - Rows every 5° of latitude from 85° S to 85° N, each with centres spaced
//   about 5° of latitude apart along it (360° split evenly, so the spacing
//   widens by 1/cos of the latitude). No point up to 85° lies farther than
//   about 390 km from a centre, well inside a disc's 463 km.
// - The outer discs a view needs are those that cover at least a tenth of a
//   disc's area of the view that no disc nearer the look-at point covers,
//   nearest first, five at most (six discs with the centre's). The view is
//   covered at most 1,500 km from the look-at point; how much of it the
//   discs shown cover is measured on the same points (coveredShare), and
//   it is whole only when they reach every point of it, with 10 km to
//   spare (reachesWholeExtent).
// - The discs are merged into one answer: each aircraft once, as the disc
//   with its freshest position has it; another disc's aircraft than the
//   centre's only with a position of known age, no older than the caller's
//   limit; none a fresher disc should list, deep enough inside its reach
//   that it cannot have flown out since, when that disc does not list it
//   (it is gone: landed, or no longer heard). Aircraft whose positions are
//   older than the caller's limit for the centre are named aged. Hidden
//   aircraft are counted once per ICAO address. At most 2,000 aircraft,
//   those nearest the look-at point.

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE = 111.32;

/** The reach of one adsb.lol disc: 250 nm. */
export const ADSBLOL_DISC_KM = 250 * 1.852;
/** Discs in one view, the centre's among them. */
export const ADSBLOL_VIEW_MAX_DISCS = 6;
/** The view is covered at most this far from the look-at point. */
export const ADSBLOL_VIEW_MAX_KM = 1500;
/** At most this many aircraft in one answer, the nearest kept. */
export const ADSBLOL_VIEW_MAX_AIRCRAFT = 2000;
/** Lattice rows this many degrees of latitude apart… */
const ROW_STEP_DEG = 5;
/** …to this latitude either way. */
const ROW_LIMIT_DEG = 85;
/** Coverage is judged on points this far apart. */
const SAMPLE_KM = 100;
/** An outer disc must cover at least this share of its own area anew. */
const MIN_GAIN_SHARE = 0.1;
/** Sample points one disc's area holds. */
const DISC_SAMPLES = (Math.PI * ADSBLOL_DISC_KM ** 2) / SAMPLE_KM ** 2;
/** No aircraft flies faster than this over the ground (km/s, 680 kt). */
const FASTEST_KMS = 0.35;
/** A disc's reach is judged this much short, for how adsb.lol measures it. */
const REACH_MARGIN_KM = 10;

/** Great-circle kilometres between two `{latitude, longitude}` points. */
export function greatCircleKm(a, b) {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * DEG) *
      Math.cos(b.latitude * DEG) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A longitude in [-180, 180). */
const wrapLongitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Degrees between two centres along a lattice row at this latitude. */
export function latticeStepDeg(latitude) {
  const around = (360 * Math.cos(latitude * DEG)) / ROW_STEP_DEG;
  return 360 / Math.max(1, Math.ceil(around - 1e-9));
}

/**
 * The lattice disc at a row's latitude and a centre's longitude, as adsb.lol
 * is asked for it: the longitude to two decimals, and the cache key the
 * flights route keys every disc by (`lat,lon`, two decimals each).
 */
function latticeDisc(latitude, longitude) {
  const lon = Math.round(wrapLongitude(longitude) * 100) / 100 || 0;
  return {
    key: `${latitude.toFixed(2)},${lon.toFixed(2)}`,
    latitude,
    longitude: lon,
  };
}

/** Lattice discs whose centres lie within `km` of the point. */
export function latticeDiscsNear(point, km) {
  const reachLat = km / KM_PER_DEGREE;
  const first = Math.max(
    -ROW_LIMIT_DEG,
    Math.ceil((point.latitude - reachLat) / ROW_STEP_DEG) * ROW_STEP_DEG,
  );
  const last = Math.min(
    ROW_LIMIT_DEG,
    Math.floor((point.latitude + reachLat) / ROW_STEP_DEG) * ROW_STEP_DEG,
  );
  const discs = new Map();
  for (let latitude = first; latitude <= last; latitude += ROW_STEP_DEG) {
    const step = latticeStepDeg(latitude);
    const count = Math.round(360 / step);
    const cos = Math.cos(Math.min(Math.abs(latitude), ROW_LIMIT_DEG) * DEG);
    const reachLon = km / (KM_PER_DEGREE * cos);
    const indices =
      reachLon >= 180
        ? Array.from({ length: count }, (_, i) => i)
        : Array.from(
            {
              length:
                Math.floor((point.longitude + reachLon) / step) -
                Math.ceil((point.longitude - reachLon) / step) +
                1,
            },
            (_, i) => Math.ceil((point.longitude - reachLon) / step) + i,
          );
    for (const index of indices) {
      const disc = latticeDisc(latitude, index * step);
      if (discs.has(disc.key)) continue;
      const away = greatCircleKm(point, disc);
      if (away <= km) discs.set(disc.key, { ...disc, km: away });
    }
  }
  return [...discs.values()];
}

/** Points about SAMPLE_KM apart over an extent, its edges included. */
function samplePoints({ west, south, east, north }) {
  const width = east < west ? east + 360 - west : east - west;
  const rows = Math.max(
    2,
    Math.ceil(((north - south) * KM_PER_DEGREE) / SAMPLE_KM) + 1,
  );
  const points = [];
  for (let row = 0; row < rows; row++) {
    const latitude = south + ((north - south) * row) / (rows - 1);
    const across = width * KM_PER_DEGREE * Math.cos(latitude * DEG);
    const columns = Math.max(2, Math.ceil(across / SAMPLE_KM) + 1);
    for (let column = 0; column < columns; column++)
      points.push({
        latitude,
        longitude: wrapLongitude(west + (width * column) / (columns - 1)),
      });
  }
  return points;
}

/** Whether a disc centred at `anchor` reaches the point. */
const reaches = (anchor, point) =>
  greatCircleKm(point, anchor) <= ADSBLOL_DISC_KM;

/**
 * The outer discs a view needs besides its centre disc, and the points its
 * coverage is judged on (coveredShare): lattice discs, nearest the look-at
 * point first, each covering at least a tenth of a disc's area of the
 * extent that the centre disc and the nearer outer discs leave, at most
 * ADSBLOL_VIEW_MAX_DISCS - 1. None while the centre disc covers the view.
 * @param {{latitude: number, longitude: number}} lookAt
 * @param {{west: number, south: number, east: number, north: number}} extent
 *   Already clipped around the look-at point (clipViewExtent).
 * @param {{latitude: number, longitude: number}} centre The centre disc's
 *   anchor.
 * @returns {{discs: Array<{key: string, latitude: number, longitude: number,
 *   km: number}>, points: Array<{latitude: number, longitude: number}>}}
 */
export function adsbLolViewPlan(lookAt, extent, centre) {
  const points = samplePoints(extent);
  let open = points.filter((point) => !reaches(centre, point));
  const least = Math.ceil(DISC_SAMPLES * MIN_GAIN_SHARE);
  const discs = [];
  if (open.length < least) return { discs, points };
  const candidates = latticeDiscsNear(
    lookAt,
    ADSBLOL_VIEW_MAX_KM + ADSBLOL_DISC_KM,
  ).sort((a, b) => a.km - b.km || a.key.localeCompare(b.key));
  for (const disc of candidates) {
    if (discs.length >= ADSBLOL_VIEW_MAX_DISCS - 1 || open.length < least)
      break;
    const left = open.filter((point) => !reaches(disc, point));
    if (open.length - left.length < least) continue;
    discs.push(disc);
    open = left;
  }
  return { discs, points };
}

/** The outer discs alone (adsbLolViewPlan). */
export const adsbLolOuterDiscs = (lookAt, extent, centre) =>
  adsbLolViewPlan(lookAt, extent, centre).discs;

/**
 * How much of a view the discs at `anchors` cover: the share of its points
 * (adsbLolViewPlan) within a disc's reach of one, and how many none reach.
 * @param {Array<{latitude: number, longitude: number}>} points
 * @param {Array<{latitude: number, longitude: number}>} anchors
 * @returns {{share: number, uncovered: number}}
 */
export function coveredShare(points, anchors) {
  let uncovered = 0;
  for (const point of points)
    if (!anchors.some((anchor) => reaches(anchor, point))) uncovered += 1;
  return {
    share: points.length ? 1 - uncovered / points.length : 0,
    uncovered,
  };
}

/** Cells are split no finer than this to settle whether a view is whole. */
const WHOLE_CELL_KM = 1;

/** The latitude in [south, north] nearest the equator. */
const nearestEquator = (south, north) =>
  south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));

/**
 * Whether the discs at `anchors` reach every point of an extent, not only
 * its sample points, by a disc's reach less REACH_MARGIN_KM. A cell of
 * about SAMPLE_KM is reached when its centre lies deeper inside a disc
 * than any of its points lies from the centre (along the meridian, then
 * the parallel: never shorter than the great circle); else it is split in
 * four, down to cells of about WHOLE_CELL_KM, which, still unsettled, are
 * counted as not reached.
 * @param {{west: number, south: number, east: number, north: number}} extent
 * @param {Array<{latitude: number, longitude: number}>} anchors
 * @returns {boolean}
 */
export function reachesWholeExtent({ west, south, east, north }, anchors) {
  const width = east < west ? east + 360 - west : east - west;
  const reachKm = ADSBLOL_DISC_KM - REACH_MARGIN_KM;
  const across = (s, n, span) =>
    span * KM_PER_DEGREE * Math.cos(nearestEquator(s, n) * DEG);
  const cells = [];
  const rows = Math.max(
    1,
    Math.ceil(((north - south) * KM_PER_DEGREE) / SAMPLE_KM),
  );
  for (let row = 0; row < rows; row++) {
    const s = south + ((north - south) * row) / rows;
    const n = south + ((north - south) * (row + 1)) / rows;
    const columns = Math.max(1, Math.ceil(across(s, n, width) / SAMPLE_KM));
    for (let column = 0; column < columns; column++)
      cells.push([s, n, west + (width * column) / columns, width / columns]);
  }
  while (cells.length) {
    const [s, n, w, span] = cells.pop();
    const centre = {
      latitude: (s + n) / 2,
      longitude: wrapLongitude(w + span / 2),
    };
    const spread = ((n - s) / 2) * KM_PER_DEGREE + across(s, n, span / 2);
    let deepest = -Infinity;
    for (const anchor of anchors)
      deepest = Math.max(deepest, reachKm - greatCircleKm(centre, anchor));
    if (deepest >= spread) continue;
    if (deepest < 0 || spread < WHOLE_CELL_KM) return false;
    const m = (s + n) / 2;
    const half = span / 2;
    cells.push(
      [s, m, w, half],
      [s, m, w + half, half],
      [m, n, w, half],
      [m, n, w + half, half],
    );
  }
  return true;
}

/** Rough kilometres from a point to a state vector's position. */
function kmTo(point, state) {
  const dLat = (state[6] - point.latitude) * KM_PER_DEGREE;
  let dLon = state[5] - point.longitude;
  dLon -= 360 * Math.round(dLon / 360);
  return Math.hypot(
    dLat,
    dLon * KM_PER_DEGREE * Math.cos(((state[6] + point.latitude) / 2) * DEG),
  );
}

/**
 * Whether a fresher disc should list an aircraft it does not: its position
 * lies inside the disc's reach deeper than the aircraft could have flown
 * between that position and the disc's own time, so it cannot have left.
 */
function goneFrom(state, at, fresher) {
  if (!(fresher.time > at) || fresher.ids.has(state[0])) return false;
  const depth =
    ADSBLOL_DISC_KM -
    REACH_MARGIN_KM -
    greatCircleKm({ latitude: state[6], longitude: state[5] }, fresher.anchor);
  return depth > FASTEST_KMS * (fresher.time - at);
}

/**
 * One answer from the discs of a view, the centre's first, each an adsb.lol
 * answer as normalizeAdsbLolPointResponse gives it, with the ICAO addresses
 * it left out (`hidden`), its anchor, and whether it is the centre's.
 * - Each aircraft is kept once, from the disc that has its freshest position
 *   (`now - seen_pos`; the earlier disc on a tie), with that disc's status
 *   and type; within one disc the first row counts, as the live contract
 *   admits it.
 * - Another disc's aircraft than the centre's is kept only with a position
 *   of known age at or after `notBeforeS` (epoch seconds).
 * - None is kept that a fresher disc should list and does not (goneFrom).
 * - Past `maxAircraft`, the nearest the look-at point are kept.
 * - Those with positions older than `agedBeforeS`, or of unknown age, are
 *   named in `agedByIcao`: drawn faded and left out of how late the layer
 *   judges the feed (snapshotRenderer.js).
 * The answer's time is the centre disc's.
 * @param {Array<{payload: {time: number, states: Array[], emergencyByIcao?: object,
 *   typeByIcao?: object}, hidden?: string[], anchor: {latitude: number,
 *   longitude: number}, centre?: boolean}>} discs
 * @param {{latitude: number, longitude: number}} lookAt
 * @param {{notBeforeS: number, agedBeforeS: number, maxAircraft?: number}} options
 * @returns {{payload: object, count: number, seen: number, gone: number,
 *   privacyHidden: number}}
 */
export function mergeAdsbLolDiscs(
  discs,
  lookAt,
  { notBeforeS, agedBeforeS, maxAircraft = ADSBLOL_VIEW_MAX_AIRCRAFT },
) {
  const listed = discs.map((disc) => ({
    disc,
    time: Number(disc.payload?.time),
    anchor: disc.anchor,
    ids: new Set(),
  }));
  const kept = new Map();
  for (const entry of listed) {
    for (const state of entry.disc.payload?.states ?? []) {
      const id = state?.[0];
      if (typeof id !== 'string' || !id || entry.ids.has(id)) continue;
      entry.ids.add(id);
      const at = Number.isFinite(state[3]) ? state[3] : -Infinity;
      if (!entry.disc.centre && !(at >= notBeforeS)) continue;
      const held = kept.get(id);
      if (held && !(at > held.at)) continue;
      kept.set(id, { state, disc: entry.disc, at });
    }
  }
  let rows = [...kept.values()];
  const present = rows.length;
  rows = rows.filter(
    ({ state, at }) =>
      !listed.some((fresher) => fresher.anchor && goneFrom(state, at, fresher)),
  );
  const gone = present - rows.length;
  const seen = rows.length;
  if (rows.length > maxAircraft)
    rows = rows
      .map((row) => ({ ...row, km: kmTo(lookAt, row.state) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, maxAircraft);
  const statuses = [];
  const types = [];
  const aged = [];
  for (const { state, disc, at } of rows) {
    const id = state[0];
    const { emergencyByIcao, typeByIcao } = disc.payload;
    if (emergencyByIcao && Object.hasOwn(emergencyByIcao, id))
      statuses.push([id, emergencyByIcao[id]]);
    if (typeByIcao && Object.hasOwn(typeByIcao, id))
      types.push([id, typeByIcao[id]]);
    if (!(at >= agedBeforeS)) aged.push(id);
  }
  const hidden = new Set(discs.flatMap((disc) => disc.hidden ?? []));
  return {
    payload: {
      time: discs[0]?.payload?.time,
      states: rows.map((row) => row.state),
      ...(statuses.length
        ? { emergencyByIcao: Object.fromEntries(statuses) }
        : {}),
      ...(types.length ? { typeByIcao: Object.fromEntries(types) } : {}),
      ...(aged.length ? { agedByIcao: aged } : {}),
    },
    count: rows.length,
    seen,
    gone,
    privacyHidden: hidden.size,
  };
}
