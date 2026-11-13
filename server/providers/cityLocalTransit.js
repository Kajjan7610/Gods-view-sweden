import { greatCircleKm } from '../../src/geoDistance.js';
import { stockholmDate } from './cityFlights.js';

// The city dossier's local traffic: the next buses, trams, metro trains and
// boats from the town's busiest stop, from Trafiklab's Realtime APIs (CC BY
// 4.0, TRAFIKLAB_REALTIME_KEY). Trains come from Trafikverket beside it, so
// they are left out here. Without the key the part is simply absent.
export const TRAFIKLAB_REALTIME_API = 'https://realtime-api.trafiklab.se/v1';
/** A town's stop is looked up once a day, its departures once a minute. */
const STOP_TTL_MS = 24 * 60 * 60_000;
const DEPARTURES_TTL_MS = 60_000;
const CACHE_MAX = 200;
/** The stop lies within this distance of the town's seat. */
const STOP_RADIUS_KM = 8;
const MAX_DEPARTURES = 8;
/** The modes shown here; TRAIN is Trafikverket's part of the dossier. */
const LOCAL_MODES = Object.freeze(['BUS', 'TRAM', 'METRO', 'BOAT']);
/**
 * Bronze allows 100 000 calls a month and 25 a minute: 3 000 a day is
 * 93 000 in a 31-day month, and 20 a minute leaves a margin. The counts live
 * in memory, so a restart on the same day starts the day's count again.
 */
export const DAILY_CALL_BUDGET = 3000;
export const MINUTE_CALL_BUDGET = 20;

const text = (value, max = 80) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const fold = (value) =>
  String(value ?? '')
    .trim()
    .toLocaleLowerCase('sv-SE');

/** A moment as Stockholm's wall clock reads it, "YYYY-MM-DD HH:mm:ss". */
const stockholmWall = (ms) =>
  new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });

/**
 * Trafiklab's local times ("2026-11-13T14:05:00", Swedish time without an
 * offset) as epoch milliseconds, or null.
 */
export function stockholmLocalMs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(value ?? ''),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const wall = `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  // Stockholm is one hour ahead of UTC in winter and two in summer.
  for (const hours of [1, 2]) {
    const ms = asUtc - hours * 3600_000;
    if (stockholmWall(ms) === wall) return ms;
  }
  return asUtc - 3600_000;
}

/**
 * The town's stop group from a stop lookup by its name: one with local
 * traffic and a stop within reach of the seat, named after the town if any
 * is, and of those the one with the most departures a day.
 * @param {object} payload GET /stops/name/{town} answer.
 * @param {{latitude: number, longitude: number}} point The town's seat.
 * @param {string} townName
 */
export function townStopGroup(payload, point, townName) {
  const groups = Array.isArray(payload?.stop_groups) ? payload.stop_groups : [];
  const name = fold(townName);
  const near = groups.filter(
    (group) =>
      typeof group?.id === 'string' &&
      group.id &&
      (Array.isArray(group.transport_modes) ? group.transport_modes : []).some(
        (mode) => LOCAL_MODES.includes(String(mode)),
      ) &&
      (Array.isArray(group.stops) ? group.stops : []).some(
        (stop) =>
          Number.isFinite(stop?.lat) &&
          Number.isFinite(stop?.lon) &&
          greatCircleKm(
            { lat: point.latitude, lon: point.longitude },
            { lat: stop.lat, lon: stop.lon },
          ) <= STOP_RADIUS_KM,
      ),
  );
  const named = near.filter((group) => fold(group.name).startsWith(name));
  const busiest = (named.length ? named : near).sort(
    (a, b) =>
      (Number(b.average_daily_stop_times) || 0) -
      (Number(a.average_daily_stop_times) || 0),
  )[0];
  return busiest ? { id: busiest.id, name: text(busiest.name, 60) } : null;
}

/**
 * The next local departures still to leave, soonest first: line, mode,
 * destination, expected time, delay, platform and the first alert's title.
 */
export function normalizeLocalDepartures(payload, nowMs) {
  const rows = Array.isArray(payload?.departures) ? payload.departures : [];
  const out = [];
  for (const row of rows) {
    const mode = String(row?.route?.transport_mode ?? '');
    if (!LOCAL_MODES.includes(mode)) continue;
    const planned = stockholmLocalMs(row.scheduled);
    if (planned === null) continue;
    const expected = stockholmLocalMs(row.realtime) ?? planned;
    if (expected < nowMs - 60_000) continue;
    const canceled = row.canceled === true || row.canceled === 'true';
    const platform =
      row.realtime_platform?.designation ?? row.scheduled_platform?.designation;
    out.push({
      line: text(row.route?.designation, 8),
      mode,
      planned,
      expected,
      delayMinutes: Math.max(0, Math.round((expected - planned) / 60_000)),
      canceled,
      destination: text(
        row.route?.destination?.name ?? row.route?.direction,
        40,
      ),
      platform: text(platform, 8),
      note: text(row.alerts?.[0]?.title, 60),
    });
  }
  out.sort((a, b) => a.expected - b.expected);
  return out.slice(0, MAX_DEPARTURES);
}

/**
 * Trafiklab Realtime departures for the dossier over one JSON fetcher. The
 * key travels in the query string, so neither URLs nor answers are logged.
 * @param {{fetchJson: Function, now: () => number, env: object}} options
 */
export function createLocalDepartures({
  fetchJson,
  now,
  env,
  dailyBudget = DAILY_CALL_BUDGET,
  minuteBudget = MINUTE_CALL_BUDGET,
}) {
  const stops = new Map();
  const boards = new Map();
  const inFlight = new Map();
  let day = { date: '', calls: 0 };
  let minute = { start: 0, calls: 0 };
  const key = () => String(env.TRAFIKLAB_REALTIME_KEY ?? '').trim();

  /** One upstream call against the day's and the minute's allowance. */
  function call(path) {
    const at = now();
    const date = stockholmDate(at);
    if (day.date !== date) day = { date, calls: 0 };
    if (at - minute.start >= 60_000) minute = { start: at, calls: 0 };
    if (day.calls >= dailyBudget)
      return Promise.reject(new Error('daily Trafiklab budget used'));
    if (minute.calls >= minuteBudget)
      return Promise.reject(new Error('Trafiklab minute budget used'));
    day.calls += 1;
    minute.calls += 1;
    return fetchJson(
      `${TRAFIKLAB_REALTIME_API}${path}?key=${encodeURIComponent(key())}`,
      { headers: { Accept: 'application/json' } },
    );
  }

  /** A value kept `ttl` per id; failures are not kept. */
  function kept(map, id, ttl, load) {
    const hit = map.get(id);
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.value);
    if (!inFlight.has(id))
      inFlight.set(
        id,
        load()
          .then((value) => {
            map.delete(id);
            map.set(id, { value, at: now() });
            if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
            return value;
          })
          .finally(() => inFlight.delete(id)),
      );
    return inFlight.get(id);
  }

  /**
   * The town's stop and its next departures; null without the key, a null
   * stop when no stop with local traffic is named after or near the town.
   */
  async function nearby(point, townName) {
    if (!key() || !String(townName ?? '').trim()) return null;
    const stop = await kept(
      stops,
      `stop:${fold(townName)}:${point.latitude.toFixed(2)}:${point.longitude.toFixed(2)}`,
      STOP_TTL_MS,
      async () =>
        townStopGroup(
          await call(
            `/stops/name/${encodeURIComponent(String(townName).trim())}`,
          ),
          point,
          townName,
        ),
    );
    if (!stop) return { stop: null, departures: [] };
    return {
      stop: stop.name,
      departures: await kept(
        boards,
        `board:${stop.id}`,
        DEPARTURES_TTL_MS,
        async () =>
          normalizeLocalDepartures(
            await call(`/departures/${encodeURIComponent(stop.id)}`),
            now(),
          ),
      ),
    };
  }

  return { nearby };
}
