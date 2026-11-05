// The city dossier's flights: the next departures and arrivals at the
// Swedavia airports near a town (Swedavia FlightInfo v2, the
// SWEDAVIA_FLIGHTINFO_KEY subscription), and at the airports Swedavia measures,
// the security queues (WaitTime Public v2, SWEDAVIA_WAITTIME_KEY). Each free
// subscription allows about 10 000 calls a month, so each answer is kept five
// minutes and each key's upstream calls stop for the day at
// DAILY_CALL_BUDGET, after which the last answer read is shown instead.

import { greatCircleKm } from '../../src/geoDistance.js';

export const SWEDAVIA_FLIGHTINFO_URL = 'https://api.swedavia.se/flightinfo/v2';
export const SWEDAVIA_WAITTIME_URL =
  'https://api.swedavia.se/waittimepublic/v2/airports';
/** The airports WaitTime measures; it answers 400 for the others. */
const WAITTIME_AIRPORTS = new Set(['ARN', 'GOT', 'BMA']);

/** Swedavia's ten airports, the busiest first. */
export const SWEDAVIA_AIRPORTS = Object.freeze([
  { iata: 'ARN', name: 'Stockholm Arlanda', lat: 59.6519, lon: 17.9186 },
  { iata: 'GOT', name: 'Göteborg Landvetter', lat: 57.6628, lon: 12.2798 },
  { iata: 'BMA', name: 'Stockholm Bromma', lat: 59.3544, lon: 17.9417 },
  { iata: 'MMX', name: 'Malmö Airport', lat: 55.5363, lon: 13.3762 },
  { iata: 'LLA', name: 'Luleå Airport', lat: 65.5438, lon: 22.122 },
  { iata: 'UME', name: 'Umeå Airport', lat: 63.7918, lon: 20.2828 },
  { iata: 'OSD', name: 'Åre Östersund Airport', lat: 63.1944, lon: 14.5003 },
  { iata: 'VBY', name: 'Visby Airport', lat: 57.6628, lon: 18.3462 },
  { iata: 'KRN', name: 'Kiruna Airport', lat: 67.822, lon: 20.3368 },
  { iata: 'RNB', name: 'Ronneby Airport', lat: 56.2667, lon: 15.265 },
]);

/** A town is served by the airports within this distance. */
const AIRPORT_RADIUS_KM = 45;
const MAX_AIRPORTS = 2;
const MAX_FLIGHTS = 4;
const BOARD_TTL_MS = 5 * 60_000;
/** A little under the free tier's 10 001 calls per 30 days. */
const DAILY_CALL_BUDGET = 320;
/** Late in the day the board continues on tomorrow's list. */
const LOOK_AHEAD_MS = 4 * 3600_000;

const text = (value, max = 60) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const bilingual = (sv, en, max) => {
  const value = { sv: text(sv, max), en: text(en, max) };
  return value.sv || value.en
    ? { sv: value.sv || value.en, en: value.en || value.sv }
    : null;
};

/** The Swedavia airports serving a point, the busiest first. */
export function airportsNear(point, radiusKm = AIRPORT_RADIUS_KM) {
  return SWEDAVIA_AIRPORTS.map((airport) => ({
    ...airport,
    km: greatCircleKm(
      { lat: point.latitude, lon: point.longitude },
      { lat: airport.lat, lon: airport.lon },
    ),
  }))
    .filter((airport) => airport.km <= radiusKm)
    .slice(0, MAX_AIRPORTS);
}

/** The Stockholm calendar date of a moment, as Swedavia's YYYY-MM-DD. */
export function stockholmDate(ms) {
  return new Date(ms).toLocaleDateString('sv-SE', {
    timeZone: 'Europe/Stockholm',
  });
}

/**
 * Flights still to leave (or land), soonest first: removed flights and those
 * that have already gone are left out, cancelled ones stay and say so.
 * @param {object[]} payloads One day's answer or more, in date order.
 * @param {'departures'|'arrivals'} kind
 * @param {number} nowMs
 */
export function normalizeBoard(payloads, kind, nowMs) {
  const departing = kind === 'departures';
  const done = departing ? 'ACT' : 'LAN';
  const seen = new Set();
  const out = [];
  for (const payload of payloads) {
    const rows = Array.isArray(payload?.flights) ? payload.flights : [];
    for (const row of rows) {
      const status = row?.locationAndStatus ?? {};
      const code = String(status.flightLegStatus ?? '').toUpperCase();
      if (code === 'DEL' || code === done) continue;
      const times = (departing ? row.departureTime : row.arrivalTime) ?? {};
      if (Date.parse(String(times.actualUtc ?? '')) <= nowMs) continue;
      const planned = Date.parse(String(times.scheduledUtc ?? ''));
      if (!Number.isFinite(planned)) continue;
      const estimated = Date.parse(String(times.estimatedUtc ?? ''));
      const expected = Number.isFinite(estimated) ? estimated : planned;
      if (expected < nowMs - 5 * 60_000) continue;
      const flight = text(row.flightId, 12);
      const key = `${flight}:${planned}`;
      if (!flight || seen.has(key)) continue;
      seen.add(key);
      out.push({
        flight,
        airline: text(row.airlineOperator?.name, 40),
        place: departing
          ? bilingual(row.arrivalAirportSwedish, row.arrivalAirportEnglish)
          : bilingual(row.departureAirportSwedish, row.departureAirportEnglish),
        planned,
        expected,
        delayMinutes: Math.max(0, Math.round((expected - planned) / 60_000)),
        canceled: code === 'CAN',
        status: bilingual(
          status.flightLegStatusSwedish,
          status.flightLegStatusEnglish,
          40,
        ),
        terminal: text(status.terminal, 8),
        gate: text(status.gate, 8),
      });
    }
  }
  return out
    .sort((a, b) => a.expected - b.expected || a.planned - b.planned)
    .slice(0, MAX_FLIGHTS);
}

/**
 * The security queues WaitTime measures, ordinary lanes first and by
 * terminal; minutes are WaitTime's projection for someone joining now.
 */
export function normalizeWaitTimes(payload) {
  const rows = Array.isArray(payload?.waitTimes) ? payload.waitTimes : [];
  return rows
    .map((row) => ({
      name: text(row?.queueName, 60),
      terminal: text(row?.terminal, 8),
      fastTrack: row?.isFastTrack === true,
      // A missing projection is unknown, not zero.
      minutes:
        row?.currentProjectedWaitTime == null
          ? NaN
          : Number(row.currentProjectedWaitTime),
      overflow: row?.overflow === true,
    }))
    .filter((row) => row.name && Number.isFinite(row.minutes))
    .map((row) => ({ ...row, minutes: Math.max(0, Math.round(row.minutes)) }))
    .sort(
      (a, b) =>
        Number(a.fastTrack) - Number(b.fastTrack) ||
        String(a.terminal ?? a.name).localeCompare(
          String(b.terminal ?? b.name),
        ),
    );
}

/**
 * Swedavia boards and security queues for a town, read through
 * `fetchJson(url, init)` (the caller's bounded fetch). Null without the
 * FlightInfo key; the queues are null without the WaitTime key.
 */
export function createSwedaviaFlights({
  fetchJson,
  now,
  env,
  dailyBudget = DAILY_CALL_BUDGET,
}) {
  const answers = new Map();
  const inFlight = new Map();
  const budgets = new Map();

  /** One upstream call against a key's daily allowance. */
  function call(key, url) {
    const date = stockholmDate(now());
    let budget = budgets.get(key);
    if (budget?.date !== date) budgets.set(key, (budget = { date, calls: 0 }));
    if (budget.calls >= dailyBudget)
      return Promise.reject(new Error('daily Swedavia budget used'));
    budget.calls += 1;
    return fetchJson(url, {
      headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' },
    });
  }

  /**
   * An answer kept five minutes; out of budget or on a failed call the last
   * one read, passed through `stale` (what has not yet gone), if any.
   */
  function kept(id, load, stale = (value) => value) {
    const hit = answers.get(id);
    if (hit && now() - hit.at < BOARD_TTL_MS) return Promise.resolve(hit.value);
    if (!inFlight.has(id))
      inFlight.set(
        id,
        load()
          .then((value) => {
            answers.set(id, { value, at: now() });
            return value;
          })
          .catch((error) => {
            if (hit) return stale(hit.value);
            throw error;
          })
          .finally(() => inFlight.delete(id)),
      );
    return inFlight.get(id);
  }

  async function readBoard(key, iata, kind) {
    const at = now();
    const today = stockholmDate(at);
    const tomorrow = stockholmDate(at + LOOK_AHEAD_MS);
    const day = (date) =>
      call(key, `${SWEDAVIA_FLIGHTINFO_URL}/${iata}/${kind}/${date}`);
    const payloads = [await day(today)];
    let flights = normalizeBoard(payloads, kind, at);
    // Towards midnight today's list runs out: continue on tomorrow's.
    if (flights.length < MAX_FLIGHTS && tomorrow !== today) {
      payloads.push(await day(tomorrow));
      flights = normalizeBoard(payloads, kind, at);
    }
    return flights;
  }

  const board = (key, iata, kind) =>
    kept(
      `${iata}:${kind}`,
      () => readBoard(key, iata, kind),
      (value) => value.filter((flight) => flight.expected >= now()),
    );

  async function security(iata) {
    const key = String(env.SWEDAVIA_WAITTIME_KEY ?? '').trim();
    if (!key || !WAITTIME_AIRPORTS.has(iata)) return null;
    try {
      return await kept(`${iata}:security`, async () =>
        normalizeWaitTimes(await call(key, `${SWEDAVIA_WAITTIME_URL}/${iata}`)),
      );
    } catch (error) {
      // The queues are extra: the flights still show without them.
      console.warn(`[city-transit] security ${iata}: ${error?.message}`);
      return null;
    }
  }

  return async function flights(point) {
    const key = String(env.SWEDAVIA_FLIGHTINFO_KEY ?? '').trim();
    if (!key) return null;
    return Promise.all(
      airportsNear(point).map(async (airport) => {
        const [departures, arrivals, queues] = await Promise.all([
          board(key, airport.iata, 'departures'),
          board(key, airport.iata, 'arrivals'),
          security(airport.iata),
        ]);
        return {
          iata: airport.iata,
          name: airport.name,
          km: Math.round(airport.km),
          departures,
          arrivals,
          security: queues,
        };
      }),
    );
  };
}
