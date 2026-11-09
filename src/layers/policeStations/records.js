/**
 * Swedish police stations from Polismyndigheten's open API
 * (polisen.se/api/policestations): pure parsing shared by the server proxy
 * and the layer. No Cesium, no Node built-ins.
 *
 * Polisen lists some 260 stations, each with a position, a street address,
 * its page on polisen.se and the services its public desk offers. About a
 * fifth list no services: they have no public desk, or Polisen states none.
 */

/** Polisen's service names, in the order a card lists them. */
export const SERVICES = Object.freeze(
  [
    ['passport-apply', 'Ansöka om pass och id-kort'],
    ['passport-collect', 'Hämta pass och id-kort'],
    ['temporary-passport', 'Ansöka om provisoriskt pass'],
    ['report', 'Anmäla brott eller borttappat föremål'],
    ['found-property', 'Lämna in upphittat föremål'],
    ['seized-property', 'Hämta ut föremål vi tagit i beslag'],
    ['weapons', 'Lämna in vapen'],
    ['temporary-plate', 'Hämta provisorisk registreringsskylt'],
    ['general-hours', 'Generell öppettid'],
    ['other', 'Andra ärenden'],
  ].map(([id, source]) => Object.freeze({ id, source })),
);
const SERVICE_BY_SOURCE = new Map(
  SERVICES.map((entry) => [entry.source, entry.id]),
);
const SERVICE_ORDER = new Map(
  SERVICES.map((entry, index) => [entry.id, index]),
);

/** What a station's desk offers, strongest first, with its colour. */
export const DESK_CLASSES = Object.freeze(
  [
    ['passport', '#1e88e5'],
    ['desk', '#80deea'],
    ['no-desk', '#90a4ae'],
  ].map(([id, color]) => Object.freeze({ id, color })),
);

/** passport: applies for passports; desk: other services; no-desk: none. */
export function deskClass(row) {
  const services = row?.services || [];
  if (services.includes('passport-apply')) return 'passport';
  return services.length ? 'desk' : 'no-desk';
}

export function deskColor(row) {
  const id = deskClass(row);
  return DESK_CLASSES.find((entry) => entry.id === id).color;
}

const PAGE_PREFIX = 'https://polisen.se/';

/**
 * One station, or null without a place in Sweden.
 * @param {object} raw One entry of Polisen's station list.
 */
export function normalizePoliceStation(raw) {
  const id = String(raw?.id ?? '')
    .replace(/\D/g, '')
    .slice(0, 12);
  const [lat, lon] = String(raw?.location?.gps ?? '')
    .split(',')
    .map(Number);
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
  const text = (value, max) =>
    typeof value === 'string' && value.trim()
      ? value.trim().replace(/\s+/g, ' ').slice(0, max)
      : null;
  const fullName = text(raw.name, 80);
  const page = text(raw.Url ?? raw.url, 300);
  const services = [
    ...new Set(
      (Array.isArray(raw.services) ? raw.services : [])
        .map((service) => SERVICE_BY_SOURCE.get(text(service?.name, 80)))
        .filter(Boolean),
    ),
  ].sort((a, b) => SERVICE_ORDER.get(a) - SERVICE_ORDER.get(b));
  return {
    id,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    // "Polisen Alingsås" names the place; the agency is the layer itself.
    name: fullName ? fullName.replace(/^Polisen\s+/i, '') || fullName : null,
    address: text(raw.location?.name, 120),
    url: page?.startsWith(PAGE_PREFIX) ? page : null,
    services,
  };
}

/**
 * Every station, those applying for passports first, then by name.
 * @param {unknown} payload Polisen's station list.
 */
export function normalizePoliceStations(payload) {
  if (!Array.isArray(payload)) throw new Error('Malformed police station list');
  const order = (row) =>
    DESK_CLASSES.findIndex((entry) => entry.id === deskClass(row));
  const seen = new Set();
  return payload
    .map(normalizePoliceStation)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id))
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.name || '').localeCompare(b.name || '', 'sv'),
    );
}

const RAD = Math.PI / 180;
/** Great-circle distance in kilometres between two [lon, lat] points. */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * The nearest other station where passports can be applied for.
 * @returns {{row: object, km: number}|null}
 */
export function nearestPassportDesk(row, stations) {
  let best = null;
  for (const other of stations) {
    if (other.id === row.id || deskClass(other) !== 'passport') continue;
    const km = distanceKm(row.point, other.point);
    if (!best || km < best.km) best = { row: other, km };
  }
  return best;
}
