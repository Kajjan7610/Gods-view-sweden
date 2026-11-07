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
 * The Swedavia airport the view is over: within AIRPORT_NEAR_KM of its
 * reference point and below AIRPORT_NEAR_HEIGHT_M, else null.
 * @param {{ lat: number, lon: number, height: number }} camera
 */
export function airportUnder(camera, airports = SWEDAVIA_AIRPORTS) {
  if (!camera || !(camera.height < AIRPORT_NEAR_HEIGHT_M)) return null;
  let best = null;
  for (const airport of airports) {
    const km = greatCircleKm(
      { lat: camera.lat, lon: camera.lon },
      { lat: airport.lat, lon: airport.lon },
    );
    if (km <= AIRPORT_NEAR_KM && (!best || km < best.km))
      best = { airport, km };
  }
  return best?.airport ?? null;
}
