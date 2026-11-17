/**
 * Trafikverket (Sweden) railway disruptions for the Rail layer. Swedish fork.
 *
 * Trafikverket publishes its railway traffic messages (track work, train
 * faults, faults in the infrastructure) as the `OperativeEvent` object of its
 * open traffic API (namespace `ols.open`, schema 1.0, CC0 1.0), which replaced
 * `TrainMessage` in 2025. Each event names the stretch it affects
 * (`EventSection`), its type (`EventType`), its start, and per traffic
 * impact (`TrafficImpact`) the stretches and stations it covers
 * (`SelectedSection`, `SectionLocation` with `Affected`), a forecast
 * (`EndDateTime` with `ForecastType`) and the message written for the public
 * (`PublicMessage`). Stations are named by signature only, so their names
 * and places come from `TrainStation` (asked once a day, in the same
 * request).
 *
 * One request per refresh, at most once every RAIL_DISRUPTIONS_REFRESH_MS,
 * shared by every viewer; a failure is held for the same time, and the last
 * snapshot is served marked stale for up to an hour. The API needs the free
 * key (TRAFIKVERKET_API_KEY): it is read on each request, travels only in the
 * request body to Trafikverket, and is never logged or sent to the browser.
 * Without it Trafikverket is never contacted.
 *
 * Only what Trafikverket publishes is passed on: ongoing events
 * (`EventState` 1, not deleted, started, not ended), placed on the Swedish
 * stations they affect.
 */

import { readResponseBytesCapped } from './httpBody.js';

export const TRAFIKVERKET_RAIL_DISRUPTIONS_URL =
  'https://api.trafikinfo.trafikverket.se/v2/data.json';
/** Shortest time between two requests to Trafikverket, success or failure. */
export const RAIL_DISRUPTIONS_REFRESH_MS = 2 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
export const RAIL_DISRUPTIONS_STALE_MAX_MS = 60 * 60_000;
/** How often the station list (names and places) is asked for again. */
export const RAIL_DISRUPTIONS_STATIONS_REFRESH_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** Bounds on what one snapshot carries. */
const MAX_EVENTS = 500;
const MAX_PLACES_PER_EVENT = 40;
const MAX_STATIONS_LISTED = 12;
/** Sweden's extent (Koster to Haparanda, Smygehuk to Treriksröset); a
 * point outside it is not drawn. */
const SWEDEN = Object.freeze({
  south: 55,
  north: 69.2,
  west: 10.95,
  east: 24.3,
});

/** Escape a value for an XML attribute. */
function xmlAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The request: every ongoing, undeleted operative event, and once a day the
 * Swedish stations' signatures, names and places.
 * @param {string} key Trafikverket API key.
 * @param {boolean} withStations
 * @returns {string}
 */
export function trafikverketRailDisruptionsQuery(key, withStations) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    `<QUERY objecttype="OperativeEvent" namespace="ols.open" schemaversion="1.0" limit="${MAX_EVENTS}">` +
    '<FILTER><AND>' +
    '<EQ name="EventState" value="1" />' +
    '<EQ name="Deleted" value="false" />' +
    '</AND></FILTER>' +
    '</QUERY>' +
    (withStations
      ? '<QUERY objecttype="TrainStation" schemaversion="1.4">' +
        '<FILTER><EQ name="CountryCode" value="SE" /></FILTER>' +
        '<INCLUDE>LocationSignature</INCLUDE>' +
        '<INCLUDE>AdvertisedLocationName</INCLUDE>' +
        '<INCLUDE>CountryCode</INCLUDE>' +
        '<INCLUDE>Geometry.WGS84</INCLUDE>' +
        '</QUERY>'
      : '') +
    '</REQUEST>'
  );
}

const asArray = (value) =>
  Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : [];

/** A trimmed, bounded text, or null. */
function text(value, max) {
  const trimmed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** An ISO time as epoch ms, or null. */
function time(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

const inSweden = ({ lat, lon }) =>
  lat >= SWEDEN.south &&
  lat <= SWEDEN.north &&
  lon >= SWEDEN.west &&
  lon <= SWEDEN.east;

/**
 * A WGS84 `POINT (a b)` as {lat, lon} inside Sweden, or null. Stations are
 * published longitude first; an operative event's centre has been seen
 * latitude first, so the order is read from the numbers: in Sweden the
 * latitude (55–69) and the longitude (10–24) never overlap.
 */
export function swedishPoint(value) {
  const match = /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const lonFirst = { lat: b, lon: a };
  if (inSweden(lonFirst)) return lonFirst;
  const latFirst = { lat: a, lon: b };
  return inSweden(latFirst) ? latFirst : null;
}

/**
 * Swedish stations by signature: name and place.
 * @param {object[]} rows TrainStation records.
 * @returns {Map<string, {name: string, lat: number|null, lon: number|null}>}
 */
export function railDisruptionStations(rows) {
  const stations = new Map();
  for (const row of asArray(rows)) {
    const signature = text(row?.LocationSignature, 12);
    if (!signature) continue;
    if (row.CountryCode && row.CountryCode !== 'SE') continue;
    const point = swedishPoint(row.Geometry?.WGS84);
    stations.set(signature, {
      name: text(row.AdvertisedLocationName, 60) ?? signature,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
    });
  }
  return stations;
}

/** A location's signature when it is in Sweden (or names no country). */
function swedishSignature(location) {
  const signature = text(location?.Signature, 12);
  if (!signature) return null;
  const country = String(location?.CountryCode ?? '').trim();
  return country && country !== 'SE' ? null : signature;
}

/** "Borås C – Varberg", or with a via: "Borås C – Varberg (via Kinna)". */
function stretchOf(sections, nameOf) {
  const lines = [];
  for (const section of sections) {
    const from = swedishSignature(section?.FromLocation);
    const to = swedishSignature(section?.ToLocation);
    const via = swedishSignature(section?.ViaLocation);
    const ends = [from, to].filter(Boolean).map(nameOf);
    if (!ends.length) continue;
    const line =
      ends.length === 2 && ends[0] === ends[1]
        ? ends[0]
        : ends.join(' – ') + (via ? ` (via ${nameOf(via)})` : '');
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.length ? lines.slice(0, 3).join('; ') : null;
}

/** Whether a public message is published now. */
function published(message, now) {
  if (!message || typeof message !== 'object') return false;
  const start = time(message.StartDateTime);
  const end = time(message.EndDateTime);
  return (start === null || start <= now) && (end === null || end > now);
}

/**
 * The forecast an impact gives: when the traffic impact is expected to end
 * (`TRAFIKPÅVERKAN`), or when a forecast is to be given (the other kind).
 */
function forecastOf(impact) {
  const at = time(impact?.EndDateTime);
  if (at === null) return { end: null, endKind: null };
  const kind = String(impact?.ForecastType ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (!kind) return { end: null, endKind: null };
  return { end: at, endKind: /trafikp/.test(kind) ? 'impact' : 'forecast' };
}

/**
 * Ongoing operative events as the Rail layer draws them: one record per
 * event and one place per affected Swedish station (or, for an event that
 * names no located station, its own centre), each place listing the events
 * there.
 * @param {object[]} events OperativeEvent records.
 * @param {Map<string, {name: string, lat: number|null, lon: number|null}>} stations
 * @param {number} now
 * @returns {{disruptions: object[], places: object[]}}
 */
export function normalizeRailDisruptions(events, stations, now) {
  const nameOf = (signature) => stations.get(signature)?.name ?? signature;
  const located = (signature) => {
    const station = stations.get(signature);
    return station && Number.isFinite(station.lat) ? station : null;
  };
  const disruptions = [];
  const places = new Map();
  const seen = new Set();
  for (const event of asArray(events)) {
    if (disruptions.length >= MAX_EVENTS) break;
    const id = text(event?.OperativeEventId, 40);
    if (!id || seen.has(id) || event.Deleted === true) continue;
    if (event.EventState !== undefined && Number(event.EventState) !== 1)
      continue;
    const start = time(event.StartDateTime);
    const ended = time(event.EndDateTime);
    if (start !== null && start > now) continue;
    if (ended !== null && ended <= now) continue;
    seen.add(id);

    // The newest impact under way speaks for the event.
    const impacts = asArray(event.TrafficImpact)
      .filter((impact) => {
        const from = time(impact?.StartDateTime);
        return from === null || from <= now;
      })
      .sort(
        (a, b) =>
          (time(b?.ModifiedDateTime) ?? 0) - (time(a?.ModifiedDateTime) ?? 0),
      );
    const impact = impacts[0] ?? null;
    const message =
      impacts
        .map((each) => each?.PublicMessage)
        .find((m) => published(m, now)) ?? null;
    const selected = impacts.flatMap((each) => asArray(each?.SelectedSection));
    const sections = selected.length ? selected : asArray(event.EventSection);

    // Affected stations, in timetable order; those with passenger exchange
    // first stand for the event on the map.
    const affected = selected
      .flatMap((section) => asArray(section?.SectionLocation))
      .filter((location) => location?.Affected === true)
      .sort((a, b) => (a?.LocationOrder ?? 0) - (b?.LocationOrder ?? 0));
    const signatures = (list) => [
      ...new Set(list.map(swedishSignature).filter(Boolean)),
    ];
    const travel = signatures(
      affected.filter(
        (location) => location?.PossibleTravelerExchange === true,
      ),
    );
    const all = signatures(affected);
    const ends = signatures(
      sections.flatMap((section) => [
        section?.FromLocation,
        section?.ToLocation,
      ]),
    );
    const named = travel.length ? travel : all.length ? all : ends;

    const updated = Math.max(
      time(event.ModifiedDateTime) ?? 0,
      time(impact?.ModifiedDateTime) ?? 0,
      time(message?.ModifiedDateTime) ?? 0,
    );
    const record = {
      id,
      reason: text(event.EventType?.Description, 80),
      header: text(message?.Header, 140),
      description: text(message?.Description, 600),
      stretch: stretchOf(sections, nameOf),
      stations: named.slice(0, MAX_STATIONS_LISTED).map(nameOf),
      moreStations: Math.max(0, named.length - MAX_STATIONS_LISTED),
      start,
      ...forecastOf(impact),
      resumption: time(event.RailRoadTimeForServiceResumption),
      updated: updated > 0 ? updated : null,
    };

    let placed = 0;
    for (const signature of named) {
      if (placed >= MAX_PLACES_PER_EVENT) break;
      const station = located(signature);
      if (!station) continue;
      placed += 1;
      const place = places.get(signature) ?? {
        id: signature,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        disruptions: [],
      };
      place.disruptions.push(id);
      places.set(signature, place);
    }
    if (!placed) {
      // No located station: the centre Trafikverket computes for the event,
      // unless every place it names is abroad.
      const foreign = [
        ...sections.flatMap((section) => [
          section?.FromLocation,
          section?.ToLocation,
        ]),
        ...affected,
      ].some((location) => location?.Signature && !swedishSignature(location));
      if (foreign && !named.length) continue;
      const centre = swedishPoint(event.Geometry?.WGS84);
      if (!centre) continue;
      places.set(`e:${id}`, {
        id: `e:${id}`,
        name: record.stretch ?? record.reason ?? id,
        lat: centre.lat,
        lon: centre.lon,
        disruptions: [id],
      });
    }
    disruptions.push(record);
  }
  // Newest first, so a place's card lists its latest event on top.
  disruptions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const order = new Map(disruptions.map((record, index) => [record.id, index]));
  for (const place of places.values())
    place.disruptions.sort((a, b) => order.get(a) - order.get(b));
  return { disruptions, places: [...places.values()] };
}

/**
 * The disruptions route's service: one shared, cached snapshot.
 * @param {{fetchImpl?: typeof fetch, env?: Record<string, string|undefined>,
 *   now?: () => number}} [options]
 */
export function createRailDisruptionsService({
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = globalThis.process?.env ?? {},
  now = () => Date.now(),
} = {}) {
  /** @type {{value: object, savedAt: number}|null} */
  let cached = null;
  /** When the last refresh (success or failure) was made. */
  let askedAt = -Infinity;
  let inFlight = null;
  let stations = new Map();
  let stationsAt = -Infinity;
  let keylessLogged = false;

  const keyOf = () => String(env.TRAFIKVERKET_API_KEY ?? '').trim();

  async function load(key, at) {
    const withStations =
      at - stationsAt >= RAIL_DISRUPTIONS_STATIONS_REFRESH_MS ||
      stations.size === 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(TRAFIKVERKET_RAIL_DISRUPTIONS_URL, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Accept: 'application/json',
        },
        body: trafikverketRailDisruptionsQuery(key, withStations),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const bytes = await readResponseBytesCapped(
        response,
        MAX_BODY_BYTES,
        controller.signal,
      );
      const results = JSON.parse(new TextDecoder().decode(bytes))?.RESPONSE
        ?.RESULT;
      if (!Array.isArray(results) || results[0]?.ERROR)
        throw new Error('query refused');
      if (withStations && Array.isArray(results[1]?.TrainStation)) {
        const next = railDisruptionStations(results[1].TrainStation);
        if (next.size) {
          stations = next;
          stationsAt = at;
        }
      }
      return {
        fetchedAt: at,
        ...normalizeRailDisruptions(results[0]?.OperativeEvent, stations, at),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last snapshot marked stale, or null once it is too old to show. */
  const lastKnown = (at) =>
    cached && at - cached.savedAt <= RAIL_DISRUPTIONS_STALE_MAX_MS
      ? { ...cached.value, stale: true }
      : null;

  /**
   * The snapshot every viewer reads: Trafikverket is asked at most once per
   * RAIL_DISRUPTIONS_REFRESH_MS, whatever happened the last time.
   * @returns {Promise<object|null>} Null when there is nothing to show.
   */
  async function snapshot(key) {
    const at = now();
    if (inFlight) return inFlight;
    if (at - askedAt < RAIL_DISRUPTIONS_REFRESH_MS)
      return cached && cached.savedAt === askedAt
        ? cached.value
        : lastKnown(at);
    askedAt = at;
    inFlight = load(key, at)
      .then((value) => {
        cached = { value: { ...value, stale: false }, savedAt: at };
        console.log(
          `[rail-disruptions] ${value.disruptions.length} disruptions at ${value.places.length} places`,
        );
        return cached.value;
      })
      .catch((error) => {
        // The message names an HTTP status or a refusal, never the body,
        // so the key stays private.
        console.warn(
          `[rail-disruptions] refresh failed: ${error?.message || error}`,
        );
        return lastKnown(at);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /**
   * Answer `GET /api/rail/disruptions`.
   * @param {{method?: string}} request
   * @returns {Promise<{status: number, headers: Record<string, string>,
   *   body: string}>}
   */
  async function handle({ method = 'GET' } = {}) {
    const reply = (status, value, headers = {}) => ({
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      },
      body: JSON.stringify(value),
    });
    if (method !== 'GET')
      return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const key = keyOf();
    if (!key) {
      if (!keylessLogged) {
        keylessLogged = true;
        console.warn(
          '[rail-disruptions] skipped: set TRAFIKVERKET_API_KEY to show railway disruptions',
        );
      }
      return reply(
        503,
        { error: 'not_configured' },
        { 'Retry-After': '3600', 'X-Data-Backoff': 'not-configured' },
      );
    }
    const value = await snapshot(key);
    if (!value)
      return reply(
        502,
        { error: 'rail_disruptions_unavailable' },
        { 'Retry-After': String(RAIL_DISRUPTIONS_REFRESH_MS / 1000) },
      );
    return reply(200, value, value.stale ? { 'X-Data-Stale': 'true' } : {});
  }

  return { handle, snapshot };
}
