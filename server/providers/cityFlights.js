// Swedavia's flights and security queues, for the city dossier's NOW tab and
// the airport board: each airport's day of departures and arrivals (Swedavia
// FlightInfo v2, the SWEDAVIA_FLIGHTINFO_KEY subscription) and, at the
// airports Swedavia measures, the queue at each security checkpoint (WaitTime
// Public v2, SWEDAVIA_WAITTIME_KEY). Each free subscription allows about
// 10 000 calls a month, so one day's list per airport and direction is read
// at most every three minutes and shared by the dossier and the board, and
// each key's upstream calls stop for the day at DAILY_CALL_BUDGET, after which
// the last answer read is shown instead.

import { greatCircleKm } from '../../src/geoDistance.js';
import {
  SWEDAVIA_AIRPORTS,
  swedaviaAirport,
  swedaviaAirportByCode,
} from '../../src/data/swedaviaAirports.js';

export { SWEDAVIA_AIRPORTS, swedaviaAirport };

export const SWEDAVIA_FLIGHTINFO_URL = 'https://api.swedavia.se/flightinfo/v2';
export const SWEDAVIA_WAITTIME_URL =
  'https://api.swedavia.se/waittimepublic/v2/airports';
/** A town is served by the airports within this distance. */
const AIRPORT_RADIUS_KM = 45;
const MAX_AIRPORTS = 2;
const MAX_FLIGHTS = 4;
/** How long one day's list (or one queue reading) is kept. */
const ANSWER_TTL_MS = 3 * 60_000;
/** A little under the free tier's 10 001 calls per 30 days. */
const DAILY_CALL_BUDGET = 320;
/** Late in the day the dossier's board continues on tomorrow's list. */
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
const time = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
const TONES = new Set(['positive', 'negative', 'neutral']);

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

/** The calendar day after a YYYY-MM-DD date. */
export function nextDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The date before a "YYYY-MM-DD" date. */
export function previousDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * One flight as the board shows it, or null for a removed or unreadable
 * row. Times are epoch milliseconds (null when Swedavia has none).
 * @param {object} row One entry of Swedavia's `flights`.
 * @param {'departures'|'arrivals'} kind
 */
export function normalizeFlight(row, kind) {
  const departing = kind === 'departures';
  const status = row?.locationAndStatus ?? {};
  const code = String(status.flightLegStatus ?? '').toUpperCase();
  if (code === 'DEL') return null;
  const times = (departing ? row.departureTime : row.arrivalTime) ?? {};
  const planned = time(times.scheduledUtc);
  const flight = text(row?.flightId, 12);
  if (!flight || planned === null) return null;
  const expected = time(times.estimatedUtc) ?? planned;
  const leg = row.flightLegIdentifier ?? {};
  const sv = Array.isArray(row.remarksSwedish) ? row.remarksSwedish : [];
  const en = Array.isArray(row.remarksEnglish) ? row.remarksEnglish : [];
  const remark = bilingual(sv[0]?.text, en[0]?.text, 40);
  const tone = String(sv[0]?.indicator ?? en[0]?.indicator ?? '').toLowerCase();
  const statusText = bilingual(
    status.flightLegStatusSwedish,
    status.flightLegStatusEnglish,
    40,
  );
  const checkIn = row.checkIn ?? {};
  const baggage = row.baggage ?? {};
  const desk = (value) =>
    Number.isFinite(Number(value)) && value !== null && value !== ''
      ? Number(value)
      : null;
  return {
    id: `${flight}:${planned}`,
    flight,
    callsign: text(leg.callsign, 10),
    airline: text(row.airlineOperator?.name, 40),
    airlineIata: text(row.airlineOperator?.iata, 3),
    place: departing
      ? bilingual(row.arrivalAirportSwedish, row.arrivalAirportEnglish)
      : bilingual(row.departureAirportSwedish, row.departureAirportEnglish),
    placeIata: text(
      departing ? leg.arrivalAirportIata : leg.departureAirportIata,
      3,
    ),
    via: (Array.isArray(row.viaDestinations) ? row.viaDestinations : [])
      .map((stop) => bilingual(stop?.airportSwedish, stop?.airportEnglish))
      .filter(Boolean)
      .slice(0, 4),
    codeshares: (Array.isArray(row.codeShareData) ? row.codeShareData : [])
      .map((id) => text(id, 12))
      .filter(Boolean)
      .slice(0, 12),
    planned,
    expected,
    actual: time(times.actualUtc),
    delayMinutes: Math.max(0, Math.round((expected - planned) / 60_000)),
    statusCode: text(code, 4),
    status: statusText,
    remark: remark && {
      ...remark,
      tone: TONES.has(tone) ? tone : 'neutral',
    },
    canceled:
      code === 'CAN' ||
      /inställ|cancel/i.test(
        `${statusText?.sv} ${statusText?.en} ${remark?.sv} ${remark?.en}`,
      ),
    terminal: text(status.terminal, 8),
    gate: text(status.gate, 8),
    gateOpen: time(status.gateOpenUtc),
    gateClose: time(status.gateCloseUtc),
    gateStatus: bilingual(status.gateActionSwedish, status.gateActionEnglish),
    checkIn:
      desk(checkIn.checkInDeskFrom) !== null
        ? {
            from: desk(checkIn.checkInDeskFrom),
            to: desk(checkIn.checkInDeskTo) ?? desk(checkIn.checkInDeskFrom),
            status: bilingual(
              checkIn.checkInStatusSwedish,
              checkIn.checkInStatusEnglish,
            ),
          }
        : null,
    baggage: text(baggage.baggageClaimUnit, 8)
      ? {
          belt: text(baggage.baggageClaimUnit, 8),
          first: time(baggage.firstBagUtc),
          last: time(baggage.lastBagUtc),
        }
      : null,
    registration: text(leg.aircraftRegistration, 10),
    // Swedavia's S(chengen), I(nternational) or D(omestic).
    scope: /^[SID]$/.test(String(row.diIndicator ?? ''))
      ? row.diIndicator
      : null,
  };
}

/** One day's answer as board rows, planned order, each flight once. */
export function normalizeDay(payload, kind) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(payload?.flights) ? payload.flights : []) {
    const flight = normalizeFlight(row, kind);
    if (!flight || seen.has(flight.id)) continue;
    seen.add(flight.id);
    out.push(flight);
  }
  return out.sort((a, b) => a.planned - b.planned || a.expected - b.expected);
}

/** A callsign or registration as Swedavia and the transponder agree on it. */
export const flightIdentity = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** Whether a flight has left (or landed) by `nowMs`. */
export function isGone(flight, kind, nowMs) {
  if (flight.statusCode === (kind === 'departures' ? 'ACT' : 'LAN'))
    return true;
  return flight.actual !== null && flight.actual <= nowMs;
}

/**
 * Flights still to leave (or land), soonest expected first: those that have
 * gone are left out, cancelled ones stay and say so.
 */
export function upcoming(flights, kind, nowMs, max = MAX_FLIGHTS) {
  const seen = new Set();
  return flights
    .filter((flight) => {
      if (seen.has(flight.id) || isGone(flight, kind, nowMs)) return false;
      seen.add(flight.id);
      return flight.expected >= nowMs - 5 * 60_000;
    })
    .sort((a, b) => a.expected - b.expected || a.planned - b.planned)
    .slice(0, max);
}

/** The dossier's short board from one day's answer or more, in date order. */
export function normalizeBoard(payloads, kind, nowMs) {
  return upcoming(
    payloads.flatMap((payload) => normalizeDay(payload, kind)),
    kind,
    nowMs,
  );
}

/**
 * The security queues WaitTime measures, ordinary lanes first and by
 * terminal; minutes are WaitTime's projection for someone joining now, the
 * position is the checkpoint's.
 */
export function normalizeWaitTimes(payload) {
  const rows = Array.isArray(payload?.waitTimes) ? payload.waitTimes : [];
  const coordinate = (value, limit) => {
    const n = Number(value);
    return value !== null && Number.isFinite(n) && Math.abs(n) <= limit
      ? n
      : null;
  };
  return rows
    .map((row) => ({
      id: text(row?.id, 12),
      name: text(row?.queueName, 60),
      terminal: text(row?.terminal, 8),
      fastTrack: row?.isFastTrack === true,
      // A missing projection is unknown, not zero.
      minutes:
        row?.currentProjectedWaitTime == null
          ? NaN
          : Number(row.currentProjectedWaitTime),
      overflow: row?.overflow === true,
      lat: coordinate(row?.latitude, 90),
      lon: coordinate(row?.longitude, 180),
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
 * Swedavia's lists and queues, read through `fetchJson(url, init)` (the
 * caller's bounded fetch). `nearby(point)` is the dossier's short board,
 * null without the FlightInfo key; `board(iata, options)` is one airport's
 * whole day. Queues are null without the WaitTime key.
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
  /** A fallback older than this is no longer the airport's present. */
  const STALE_SHOW_MS = 15 * 60_000;
  /** After midnight yesterday's list is read this long, and this seldom. */
  const LOOK_BACK_MS = 3 * 3600_000;
  const YESTERDAY_TTL_MS = 30 * 60_000;
  /** An answer fit to show: fresh, or a fallback from the last minutes. */
  const current = (entry) => {
    if (entry.stale && now() - entry.at > STALE_SHOW_MS)
      throw new Error('the last Swedavia answer is too old');
    return entry;
  };
  const flightKey = () => String(env.SWEDAVIA_FLIGHTINFO_KEY ?? '').trim();
  const waitKey = () => String(env.SWEDAVIA_WAITTIME_KEY ?? '').trim();

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
   * An answer kept ANSWER_TTL_MS as `{ value, at, stale }`; out of budget or
   * on a failed call the last one read, marked stale, if any.
   */
  function kept(id, load, ttl = ANSWER_TTL_MS) {
    const hit = answers.get(id);
    if (hit && now() - hit.at < ttl)
      return Promise.resolve({ ...hit, stale: false });
    if (!inFlight.has(id))
      inFlight.set(
        id,
        load()
          .then((value) => {
            const entry = { value, at: now() };
            answers.set(id, entry);
            // Yesterday's lists are not asked for again.
            if (answers.size > 80) answers.delete(answers.keys().next().value);
            return { ...entry, stale: false };
          })
          .catch((error) => {
            if (hit) return { ...hit, stale: true };
            throw error;
          })
          .finally(() => inFlight.delete(id)),
      );
    return inFlight.get(id);
  }

  /** One airport's day in one direction. */
  const day = (key, iata, kind, date, ttl) =>
    kept(
      `${iata}:${kind}:${date}`,
      async () =>
        normalizeDay(
          await call(key, `${SWEDAVIA_FLIGHTINFO_URL}/${iata}/${kind}/${date}`),
          kind,
        ),
      ttl,
    );

  /** The dossier's next flights: today's, and towards midnight tomorrow's. */
  async function next(key, iata, kind) {
    const at = now();
    const today = stockholmDate(at);
    const lists = [current(await day(key, iata, kind, today)).value];
    // Just after midnight yesterday's late flights are still to come. That
    // list hardly changes any more, so it is read far more seldom.
    if (stockholmDate(at - LOOK_BACK_MS) !== today)
      try {
        lists.unshift(
          current(
            await day(key, iata, kind, previousDate(today), YESTERDAY_TTL_MS),
          ).value,
        );
      } catch {
        // Yesterday's list is an extra: today's flights show without it.
      }
    let flights = upcoming(lists.flat(), kind, at);
    if (
      flights.length < MAX_FLIGHTS &&
      stockholmDate(at + LOOK_AHEAD_MS) !== today
    ) {
      lists.push(current(await day(key, iata, kind, nextDate(today))).value);
      flights = upcoming(lists.flat(), kind, at);
    }
    return flights;
  }

  async function security(iata) {
    const key = waitKey();
    if (!key || !swedaviaAirport(iata)?.queues) return null;
    try {
      return await kept(`${iata}:security`, async () =>
        normalizeWaitTimes(await call(key, `${SWEDAVIA_WAITTIME_URL}/${iata}`)),
      );
    } catch (error) {
      // The queues are extra: the flights still show without them.
      console.warn(`[airport-board] security ${iata}: ${error?.message}`);
      return null;
    }
  }

  async function nearby(point) {
    const key = flightKey();
    if (!key) return null;
    return Promise.all(
      airportsNear(point).map(async (airport) => {
        const [departures, arrivals, queues] = await Promise.all([
          next(key, airport.iata, 'departures'),
          next(key, airport.iata, 'arrivals'),
          security(airport.iata),
        ]);
        return {
          iata: airport.iata,
          name: airport.name,
          km: Math.round(airport.km),
          departures,
          arrivals,
          // Queue minutes from a quarter of an hour ago are not the queue.
          security:
            queues && !(queues.stale && now() - queues.at > STALE_SHOW_MS)
              ? queues.value
              : null,
        };
      }),
    );
  }

  /**
   * One airport's whole day for the board: every flight of `date`
   * ('today' or 'tomorrow') in both directions with the queues, or the
   * queues alone (`only: 'security'`). Null for an airport that is not
   * Swedavia's; flights are null without the FlightInfo key.
   */
  async function board(iata, { date = 'today', only = null } = {}) {
    const airport = swedaviaAirport(iata);
    if (!airport) return null;
    const today = stockholmDate(now());
    const listDate = date === 'tomorrow' ? nextDate(today) : today;
    const key = flightKey();
    const wantFlights = only !== 'security' && Boolean(key);
    const [departures, arrivals, queues] = await Promise.all([
      wantFlights ? day(key, airport.iata, 'departures', listDate) : null,
      wantFlights ? day(key, airport.iata, 'arrivals', listDate) : null,
      security(airport.iata),
    ]);
    const parts = [departures, arrivals, queues].filter(Boolean);
    return {
      airport: {
        iata: airport.iata,
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        queues: airport.queues,
      },
      date: listDate,
      flights: Boolean(key),
      departures: departures?.value ?? null,
      arrivals: arrivals?.value ?? null,
      security: queues?.value ?? null,
      // The oldest part's reading, and whether any is a fallback.
      updatedAt: parts.length
        ? Math.min(...parts.map((part) => part.at))
        : null,
      stale: parts.some((part) => part.stale),
    };
  }

  /**
   * The followed aircraft's own rows: its departure and/or arrival at
   * Swedavia airports today, found by callsign (what the transponder sends)
   * or registration. `airports` are the codes worth reading (the route's
   * ends, the board it was followed from; Swedavia's only, at most three);
   * every day list already kept is searched as well, at no cost.
   */
  async function findFlight({ callsign, registration, airports = [] }) {
    const key = flightKey();
    const wanted = new Set([
      flightIdentity(callsign),
      flightIdentity(registration),
    ]);
    wanted.delete('');
    if (!key || !wanted.size) return null;
    const today = stockholmDate(now());
    const codes = [
      ...new Set(
        airports
          .map((code) => swedaviaAirportByCode(code)?.iata)
          .filter(Boolean),
      ),
    ].slice(0, 3);
    await Promise.allSettled(
      codes.flatMap((iata) =>
        ['departures', 'arrivals'].map((kind) => day(key, iata, kind, today)),
      ),
    );
    const sign = flightIdentity(callsign);
    const tail = flightIdentity(registration);
    const byCallsign = [];
    const byTail = [];
    for (const [id, entry] of answers) {
      const [iata, kind, date] = id.split(':');
      if (date !== today || !Array.isArray(entry.value)) continue;
      const airport = { iata, name: swedaviaAirport(iata).name };
      for (const flight of entry.value) {
        if (sign && flightIdentity(flight.callsign) === sign)
          byCallsign.push({ airport, kind, flight });
        else if (tail && flightIdentity(flight.registration) === tail)
          byTail.push({ airport, kind, flight });
      }
    }
    const order = (a, b) => a.flight.planned - b.flight.planned;
    // The callsign names this flight; the registration names the airframe,
    // which flies several legs a day: then only the leg under way counts,
    // its latest departure so far and the first arrival still to come.
    if (byCallsign.length) return byCallsign.sort(order).slice(0, 2);
    const at = now();
    const departed = byTail
      .filter((leg) => leg.kind === 'departures' && leg.flight.expected <= at)
      .sort(order)
      .at(-1);
    const arriving = byTail
      .filter((leg) => leg.kind === 'arrivals' && leg.flight.expected >= at)
      .sort(order)[0];
    // Not yet off and nothing inbound: it waits at the gate for its next.
    const waiting = byTail
      .filter((leg) => leg.kind === 'departures' && leg.flight.expected > at)
      .sort(order)[0];
    return [departed ?? (arriving ? null : waiting), arriving].filter(Boolean);
  }

  /**
   * Today's departures from one Swedavia airport grouped by destination:
   * the flights (cancelled ones not counted), their airlines and the next
   * one still to go. Null for an airport that is not Swedavia's or without
   * the FlightInfo key.
   */
  async function routes(iata) {
    const airport = swedaviaAirport(iata);
    const key = flightKey();
    if (!airport || !key) return null;
    const list = await day(
      key,
      airport.iata,
      'departures',
      stockholmDate(now()),
    );
    const at = now();
    const byPlace = new Map();
    for (const flight of list.value) {
      if (flight.canceled || !flight.placeIata) continue;
      const route = byPlace.get(flight.placeIata) ?? {
        iata: flight.placeIata,
        place: flight.place,
        flights: 0,
        airlines: new Set(),
        next: null,
      };
      route.flights += 1;
      if (flight.airline) route.airlines.add(flight.airline);
      if (
        flight.expected >= at &&
        (route.next === null || flight.planned < route.next)
      )
        route.next = flight.planned;
      byPlace.set(flight.placeIata, route);
    }
    return {
      airport: {
        iata: airport.iata,
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
      },
      updatedAt: list.at,
      routes: [...byPlace.values()]
        .map((route) => ({
          ...route,
          airlines: [...route.airlines].slice(0, 6),
        }))
        .sort((a, b) => b.flights - a.flights || a.iata.localeCompare(b.iata)),
    };
  }

  return { nearby, board, findFlight, routes };
}
