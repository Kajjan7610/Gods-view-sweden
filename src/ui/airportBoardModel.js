/**
 * The airport board's pure rules: which flights a search keeps, how a
 * flight reads (gone, cancelled, late, good news), where "now" falls in the
 * day, how long a security queue is, and which Swedavia airport the view is
 * over. Flights are /api/airport-board's rows (server/providers/cityFlights.js).
 */
import { SWEDAVIA_AIRPORTS } from '../data/swedaviaAirports.js';
import { greatCircleKm } from '../geoDistance.js';

/** A delay this long reads as bad news even without Swedavia saying so. */
export const LATE_MINUTES = 15;
/** The view is at the airport within this distance and below this height. */
export const AIRPORT_NEAR_KM = 6;
export const AIRPORT_NEAR_HEIGHT_M = 25_000;

const fold = (value) =>
  String(value ?? '')
    .toLocaleLowerCase('sv-SE')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

/**
 * Whether a flight answers a search: its flight number or codeshares,
 * destination or origin (either language, or its IATA code), airline or
 * via stops. Every word must match somewhere.
 */
export function matchesQuery(flight, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold(
    [
      flight.flight,
      ...(flight.codeshares ?? []),
      flight.place?.sv,
      flight.place?.en,
      flight.placeIata,
      flight.airline,
      flight.callsign,
      ...(flight.via ?? []).flatMap((stop) => [stop.sv, stop.en]),
    ]
      .filter(Boolean)
      .join(' '),
  );
  // Flight numbers are written with and without a space ("SK 1427").
  const compact = haystack.replace(/\s+/g, '');
  return words.every(
    (word) => haystack.includes(word) || compact.includes(word),
  );
}

/** Whether a flight has left (or landed) by `nowMs`. */
export function isGone(flight, kind, nowMs) {
  if (flight.statusCode === (kind === 'departures' ? 'ACT' : 'LAN'))
    return true;
  return flight.actual != null && flight.actual <= nowMs;
}

/**
 * How a row reads: 'canceled', 'gone', 'negative' (Swedavia's bad news or
 * a long delay), 'positive' (boarding, go to gate) or 'neutral'.
 */
export function flightTone(flight, kind, nowMs) {
  if (flight.canceled) return 'canceled';
  if (isGone(flight, kind, nowMs)) return 'gone';
  if (flight.remark?.tone === 'negative' || flight.delayMinutes >= LATE_MINUTES)
    return 'negative';
  if (flight.remark?.tone === 'positive') return 'positive';
  return 'neutral';
}

/**
 * Where "now" falls on a day's board, which runs in scheduled order as the
 * terminal's screens do: before the first flight scheduled from now on, the
 * list's length when none is. A late flight scheduled earlier stays above.
 */
export function nowIndex(flights, nowMs) {
  const index = flights.findIndex((flight) => flight.planned >= nowMs);
  return index < 0 ? flights.length : index;
}

/** A queue's length: 'short' under 5 minutes, 'long' from 15, else 'medium'. */
export function queueLevel(minutes, overflow = false) {
  if (overflow || minutes >= LATE_MINUTES) return 'long';
  return minutes >= 5 ? 'medium' : 'short';
}

/**
 * The Swedavia airport the view is over: within `km` of its reference point
 * and below `height` metres (AIRPORT_NEAR_KM and AIRPORT_NEAR_HEIGHT_M by
 * default), the nearest if several, else null.
 * @param {{ lat: number, lon: number, height: number }} camera
 */
export function airportUnder(
  camera,
  airports = SWEDAVIA_AIRPORTS,
  { km = AIRPORT_NEAR_KM, height = AIRPORT_NEAR_HEIGHT_M } = {},
) {
  if (!camera || !(camera.height < height)) return null;
  let best = null;
  for (const airport of airports) {
    const distance = greatCircleKm(
      { lat: camera.lat, lon: camera.lon },
      { lat: airport.lat, lon: airport.lon },
    );
    if (distance <= km && (!best || distance < best.distance))
      best = { airport, distance };
  }
  return best?.airport ?? null;
}

/**
 * The map's queue markers: one per checkpoint position (its ordinary lane
 * and fast track share a door), with the ordinary lane's minutes, the fast
 * track's beside them, and the length of the queue that leads.
 * @param {object[]} queues /api/airport-board's `security`.
 */
export function queueMarkers(queues) {
  const groups = new Map();
  for (const queue of queues ?? []) {
    if (!Number.isFinite(queue.lat) || !Number.isFinite(queue.lon)) continue;
    const key = `${queue.lat.toFixed(4)},${queue.lon.toFixed(4)}`;
    const group = groups.get(key) ?? { key, lat: queue.lat, lon: queue.lon };
    group[queue.fastTrack ? 'fast' : 'ordinary'] = queue;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ key, lat, lon, ordinary, fast }) => {
      const lead = ordinary ?? fast;
      return {
        key,
        lat,
        lon,
        terminal: lead.terminal,
        minutes: lead.minutes,
        fastTrack: ordinary && fast ? fast.minutes : null,
        onlyFastTrack: !ordinary,
        level: queueLevel(lead.minutes, lead.overflow),
      };
    })
    .sort((a, b) =>
      String(a.terminal ?? '').localeCompare(String(b.terminal ?? '')),
    );
}
