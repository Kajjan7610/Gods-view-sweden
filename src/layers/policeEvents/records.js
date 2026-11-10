/**
 * Swedish Police (Polismyndigheten) event notices: pure parsing shared by the
 * server proxy and the layer. No Cesium, no Node built-ins.
 *
 * polisen.se/api/events returns the 500 latest notices — a short summary of a
 * selection of call-outs, often published hours after the event. Each names
 * the municipality in its title ("4 november 17.02, Trafikolycka, Göteborg")
 * but carries only the county's centre coordinate, so the proxy places a
 * notice at its municipality's seat from a bundled gazetteer and keeps the
 * county centre for county-wide notices (night summaries and the like).
 * Open data: free to use, crediting Polismyndigheten.
 */

/** Categories, in legend order; `match` reads the Swedish event type. */
export const EVENT_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'violence',
    color: '#ff1744',
    match:
      // "rån" as a word of its own: not "smitning från", not "olaga intrång".
      /misshandel|mord(?!brand)|dråp|(?<![a-zåäö])rån(?![a-zåäö])|olaga hot|våld|knivlag|vapenlag|skottlossning|sexualbrott|ofredande|explosion|sprängning|detonation|bombhot|farligt föremål|människorov|bråk|upplopp/i,
  }),
  Object.freeze({
    id: 'traffic',
    color: '#ffd600',
    match: /^trafik|rattfylleri|olovlig körning/i,
  }),
  Object.freeze({
    id: 'fire',
    color: '#ff9100',
    match: /brand|olycka|olycksfall|sjukdom|drunkning|räddning/i,
  }),
  Object.freeze({
    id: 'property',
    color: '#b388ff',
    match:
      /stöld|inbrott|bedrägeri|skadegörelse|motorfordon|häleri|olaga intrång|tillgrepp/i,
  }),
  Object.freeze({
    id: 'drugs',
    color: '#00e5ff',
    match: /narkotika|fylleri|lob\b|alkohol/i,
  }),
  Object.freeze({
    id: 'missing',
    color: '#69f0ae',
    match: /försvunnen|anträffad/i,
  }),
  Object.freeze({ id: 'other', color: '#b0bec5', match: null }),
  // County-wide night and evening summaries; hidden by default.
  Object.freeze({ id: 'summary', color: '#78909c', match: /^sammanfattning/i }),
]);
const CATEGORY_BY_ID = new Map(
  EVENT_CATEGORIES.map((entry) => [entry.id, entry]),
);

export const MAX_EVENTS = 1000;
const MAX_TEXT = 600;

/** Category id for one Polisen event type, e.g. "Trafikolycka, vilt". */
export function eventCategory(type) {
  const text = String(type ?? '');
  if (/^sammanfattning/i.test(text)) return 'summary';
  for (const entry of EVENT_CATEGORIES)
    if (entry.match && entry.id !== 'summary' && entry.match.test(text))
      return entry.id;
  return 'other';
}

export function categoryColor(id) {
  return CATEGORY_BY_ID.get(id)?.color || CATEGORY_BY_ID.get('other').color;
}

const text = (value, max = MAX_TEXT) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Swedish clock time to epoch milliseconds: summer time (UTC+2) runs from
 * 01:00 UTC on the last Sunday in March to the last Sunday in October.
 * @param {string} wall "2026-07-01T09:05:00", Swedish local time.
 */
function swedishWallTime(wall) {
  const asUtc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(asUtc)) return null;
  const year = new Date(asUtc).getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  const summer = asUtc - 2 * 3_600_000;
  return summer >= lastSunday(2) && summer < lastSunday(9)
    ? summer
    : asUtc - 3_600_000;
}

/**
 * "2026-11-04 17:12:33 +01:00" to epoch milliseconds, or null. A time
 * without a zone is Swedish local time, summer or winter.
 */
export function parseEventTime(value) {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(
      String(value ?? '').trim(),
    );
  if (!match) return null;
  const [, day, hour, minute, second = '00', zone] = match;
  const wall = `${day}T${hour.padStart(2, '0')}:${minute}:${second}`;
  if (!zone) return swedishWallTime(wall);
  const offset =
    zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${wall}${offset}`);
  return Number.isFinite(ms) ? ms : null;
}

/** "58.252793,13.059643" (lat,lon) to [lon, lat], or null. */
export function parseGps(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((part) => part.trim());
  // An empty half is a missing coordinate, not 0.
  if (parts.length !== 2 || parts.includes('')) return null;
  const [lat, lon] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/** The place a notice names last in its title: municipality or county. */
export function placeOf(title) {
  const parts = String(title ?? '').split(',');
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

const fold = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('sv-SE')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Build a place lookup from [code, name, seat, lon, lat] rows. A name is the
 * municipality's genitive ("Stockholms", "Falu"); Polisen writes the plain
 * form ("Stockholm", "Falun"), so each name also answers without its final
 * "s", and by its seat. Exact names win over those derived forms.
 * @param {Array<[string, string, string, number, number]>} rows
 * @returns {(place: string) => [number, number] | null}
 */
export function createPlaceLookup(rows) {
  const exact = new Map();
  const derived = new Map();
  for (const [, name, seat, lon, lat] of rows || []) {
    const point = [lon, lat];
    exact.set(fold(name), point);
    if (name.endsWith('s') && name.length > 3)
      derived.set(fold(name.slice(0, -1)), point);
    if (seat) derived.set(fold(seat), point);
  }
  return (place) => {
    const key = fold(place);
    return exact.get(key) || derived.get(key) || null;
  };
}

/**
 * Normalize one notice; null without an id, time or any position.
 * @param {object} event
 * @param {(place: string) => [number, number] | null} lookup
 */
export function normalizePoliceEvent(event, lookup) {
  const id = event?.id;
  const time = parseEventTime(event?.datetime);
  if (id == null || time == null) return null;
  const title = text(event.name, 200);
  const type = text(event.type, 80) || 'Övrigt';
  const county = text(event.location?.name, 80);
  const place = placeOf(title);
  const municipal =
    place && !/ län$/i.test(place) && lookup ? lookup(place) : null;
  const point = municipal || parseGps(event.location?.gps);
  if (!point) return null;
  const path = text(event.url, 300);
  return {
    id: String(id).slice(0, 20),
    time,
    type,
    category: eventCategory(type),
    title,
    summary: text(event.summary),
    place: municipal ? place : county || place,
    county,
    precision: municipal ? 'municipality' : 'county',
    point,
    link:
      path && path.startsWith('/') && !path.startsWith('//')
        ? `https://polisen.se${path}`
        : null,
  };
}

/**
 * Normalize the API answer, newest first.
 * @param {object[]} payload Parsed JSON body (an array of notices).
 * @param {(place: string) => [number, number] | null} lookup
 * @returns {{events: object[], truncated: boolean}}
 */
export function normalizePoliceEvents(payload, lookup) {
  if (!Array.isArray(payload)) throw new Error('Malformed Polisen events');
  const events = [];
  const seen = new Set();
  for (const event of payload) {
    if (events.length >= MAX_EVENTS) break;
    const row = normalizePoliceEvent(event, lookup);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    events.push(row);
  }
  events.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  return { events, truncated: payload.length > MAX_EVENTS };
}

/**
 * Spread notices that share a place on a golden-angle spiral around it,
 * newest nearest the centre, so each stays clickable. Offsets are metres.
 * @param {object[]} events Newest first.
 * @param {number} [stepM]
 * @returns {Map<string, [number, number]>} id → [lon, lat]
 */
export function spreadAroundPlaces(events, stepM = 900) {
  const counts = new Map();
  const out = new Map();
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (const row of events) {
    const key = row.point.join(',');
    const index = counts.get(key) || 0;
    counts.set(key, index + 1);
    if (index === 0) {
      out.set(row.id, row.point);
      continue;
    }
    const radius = stepM * Math.sqrt(index);
    const angle = index * GOLDEN;
    const [lon, lat] = row.point;
    const dLat = (radius * Math.cos(angle)) / 111_320;
    const dLon =
      (radius * Math.sin(angle)) /
      (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    out.set(row.id, [lon + dLon, lat + dLat]);
  }
  return out;
}
