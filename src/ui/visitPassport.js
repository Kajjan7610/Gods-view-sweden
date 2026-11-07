/**
 * The visit passport: every Swedish town the city dossier presents gets a
 * stamp, kept in this browser. Challenges count stamps against Sweden's
 * map. No DOM besides the injected storage, no Cesium, no i18n.
 */

export const PASSPORT_STORAGE_KEY = 'gev:visit-passport:v1';
export const MUNICIPALITY_COUNT = 290;
/** The Arctic Circle's latitude, rounded as maps print it. */
export const ARCTIC_CIRCLE_LAT = 66.5627;
/** The 21 county seats (residensstäder), by municipality code. */
export const COUNTY_SEAT_CODES = Object.freeze([
  '0180',
  '0380',
  '0480',
  '0580',
  '0680',
  '0780',
  '0880',
  '0980',
  '1080',
  '1280',
  '1380',
  '1480',
  '1780',
  '1880',
  '1980',
  '2080',
  '2180',
  '2281',
  '2380',
  '2480',
  '2580',
]);
/** County codes (the municipality code's first two digits). */
export const COUNTY_CODES = Object.freeze([
  '01',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '12',
  '13',
  '14',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
]);
const MAX_STAMPS = MUNICIPALITY_COUNT;
/** A return within this time is the same visit: panning back and forth
    over two towns does not count up. */
export const REVISIT_GAP_MS = 10 * 60_000;

function emptyPassport() {
  return { stamps: {}, cinematic: true, showMap: false };
}

/** The stored passport, or an empty one when storage is missing or broken. */
export function loadPassport(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PASSPORT_STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed.stamps !== 'object') return emptyPassport();
    return {
      stamps: parsed.stamps,
      cinematic: parsed.cinematic !== false,
      showMap: parsed.showMap === true,
    };
  } catch {
    return emptyPassport();
  }
}

export function savePassport(storage, passport) {
  try {
    storage?.setItem(PASSPORT_STORAGE_KEY, JSON.stringify(passport));
  } catch {
    /* private mode or full storage: the passport lives for this page only */
  }
}

/**
 * Stamp a town. The first visit is remembered with its time; later ones
 * count, once at least REVISIT_GAP_MS has passed since the last. Returns
 * whether this was the town's first stamp.
 * @param {object} passport Changed in place.
 * @param {{code: string, name: string, county?: string, point: number[]}} city
 * @param {number} nowMs
 */
export function stampVisit(passport, city, nowMs) {
  const code = String(city?.code ?? '');
  if (!/^\d{4}$/.test(code)) return false;
  const existing = passport.stamps[code];
  if (existing) {
    if (nowMs - (existing.last ?? 0) >= REVISIT_GAP_MS)
      existing.count = (existing.count || 1) + 1;
    existing.last = nowMs;
    return false;
  }
  if (Object.keys(passport.stamps).length >= MAX_STAMPS) return false;
  passport.stamps[code] = {
    name: String(city.name ?? code).slice(0, 60),
    county: String(city.county ?? '').slice(0, 60),
    point: Array.isArray(city.point)
      ? city.point.slice(0, 2).map(Number)
      : null,
    first: nowMs,
    last: nowMs,
    count: 1,
  };
  return true;
}

/** Stamps oldest first, as the journey ran. */
export function stampsInOrder(passport) {
  return Object.entries(passport.stamps)
    .map(([code, stamp]) => ({ code, ...stamp }))
    .sort((a, b) => a.first - b.first);
}

/** Every visit in the passport, first ones and returns. */
export function totalVisits(passport) {
  return Object.values(passport.stamps).reduce(
    (sum, stamp) => sum + (stamp.count || 1),
    0,
  );
}

/** The towns visited most often, most recent first among equals. */
export function mostVisited(passport, max = 5) {
  return Object.entries(passport.stamps)
    .map(([code, stamp]) => ({ code, ...stamp, count: stamp.count || 1 }))
    .sort((a, b) => b.count - a.count || (b.last ?? 0) - (a.last ?? 0))
    .slice(0, max);
}

/**
 * Progress on each challenge: `{id, done, total}`.
 * @param {object} passport
 */
export function challengeProgress(passport) {
  const codes = Object.keys(passport.stamps);
  const stamps = Object.values(passport.stamps);
  const counties = new Set(codes.map((code) => code.slice(0, 2)));
  return [
    {
      id: 'seats',
      done: COUNTY_SEAT_CODES.filter((code) => passport.stamps[code]).length,
      total: COUNTY_SEAT_CODES.length,
    },
    {
      id: 'counties',
      done: COUNTY_CODES.filter((code) => counties.has(code)).length,
      total: COUNTY_CODES.length,
    },
    {
      id: 'arctic',
      done: Math.min(
        3,
        stamps.filter((stamp) => Number(stamp.point?.[1]) > ARCTIC_CIRCLE_LAT)
          .length,
      ),
      total: 3,
    },
    {
      id: 'all',
      done: codes.length,
      total: MUNICIPALITY_COUNT,
    },
  ];
}
