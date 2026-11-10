import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  latestProduction,
  normalizeFlows,
  normalizeProductionDay,
} from '../../src/layers/powerGrid/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Svenska kraftnät's control room (no key): the data service behind
// svk.se/om-kraftsystemet/kontrollrummet. map/flow answers the latest
// quarter-hour flow on every Nordic link; production answers the day's
// quarter-hours per type for Sweden. Both change every quarter-hour, so each
// is read at most once every five minutes, and only while the layer asks:
// one production read gives `/` its latest values and `/day` and `/week`
// their points. The service refuses requests that do not look like they come
// from its page.
//
// A failed read, of the flows or of production each on its own, leaves the
// service alone for a minute. Meanwhile the last answer is served marked
// stale, for two hours at most. Flows are answered even when production
// failed, with the last production known.
//
// Production answers the current day only (an earlier date is a 403, so none
// is ever asked for), so for the week the server keeps each day it has seen
// on disk. Once the layer has asked, it also fetches the day every quarter of
// an hour while it runs, so a day is whole even when nobody watched it end.
// A new day starts without quarter-hours: that empty answer is kept like any
// other, and the latest values are then the last of the evening before.
export const FLOW_URL = (ticks) =>
  `https://www.svk.se/services/controlroom/v2/map/flow?ticks=${ticks}`;
export const PRODUCTION_URL = (date) =>
  `https://www.svk.se/services/controlroom/v2/production?date=${date}&countryCode=SE`;
const TTL_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
/** After a failed read the control room is left alone this long. */
export const POWER_GRID_RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const QUARTER_MS = 15 * 60_000;
/** Days the week route shows, today included. */
export const WEEK_DAYS = 7;
/** Days kept on disk; older ones are removed. */
const KEEP_DAYS = 8;
const HEADERS = Object.freeze({
  Accept: 'application/json',
  Referer: 'https://www.svk.se/om-kraftsystemet/kontrollrummet/',
  'User-Agent': 'Mozilla/5.0 (compatible; GodsEyeView-Sweden)',
});
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const STOCKHOLM_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "2026-11-04": the Stockholm calendar date of `ms`. */
const stockholmDate = (ms) => STOCKHOLM_DATE.format(ms);

/**
 * A "YYYY-MM-DD" date moved by whole calendar days. Dates, not 24 hours: a
 * day of 23 or 25 hours neither skips nor repeats one.
 */
export function stepDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** Bounded power-grid route for dev and preview. */
export function powerGridProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'power-grid-days'),
  schedule = (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  },
} = {}) {
  /** The last good flows, as {value, at}; `at` is when that read began. */
  let flows = null;
  /** The last production answer, as {date, points, latest, at}. */
  let day = null;
  /** The last production values that had a total; they outlive their day. */
  let lastKnown = null;
  /** The date whose eve has been looked up on disk for `lastKnown`. */
  let eveRead = null;
  let flowsRetryAfter = 0;
  let dayRetryAfter = 0;
  const inFlight = new Map();
  /** Points on disk per date, so a shorter answer never overwrites a longer. */
  const stored = new Map();
  let saver = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  const fresh = (held, at) => Boolean(held) && at - held.at < TTL_MS;
  /** The held production answer when it is `date`'s, never another day's. */
  const dayOn = (date) => (day?.date === date ? day : null);
  const flowsDue = (at) => !fresh(flows, at) && at >= flowsRetryAfter;
  const dayDue = (at) =>
    !fresh(dayOn(stockholmDate(at)), at) && at >= dayRetryAfter;

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: HEADERS,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readDay(date) {
    try {
      const saved = JSON.parse(
        await readFile(path.join(cacheDir, `${date}.json`), 'utf8'),
      );
      const points = Array.isArray(saved?.points) ? saved.points : [];
      stored.set(date, Math.max(stored.get(date) ?? 0, points.length));
      return points;
    } catch {
      return null;
    }
  }

  /** Keep a day's quarter-hours on disk; drop days past the week. */
  async function saveDay(date, points) {
    if (!points.length) return;
    // What an earlier run kept counts too.
    if (!stored.has(date)) await readDay(date);
    if (points.length < (stored.get(date) ?? 0)) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        path.join(cacheDir, `${date}.json`),
        JSON.stringify({ date, points }),
      );
      stored.set(date, points.length);
      const oldest = stepDate(stockholmDate(now()), -(KEEP_DAYS - 1));
      for (const name of await readdir(cacheDir)) {
        const kept = name.match(DATE_FILE)?.[1];
        if (kept && kept < oldest) {
          await unlink(path.join(cacheDir, name)).catch(() => {});
          stored.delete(kept);
        }
      }
    } catch (error) {
      console.warn(
        `[power-grid] could not keep ${date}: ${error?.message || error}`,
      );
    }
  }

  /** One shared flows read; a failure keeps the last and starts the pause. */
  function refreshFlows() {
    return coalesceProxyRequest(inFlight, 'flows', async () => {
      const at = now();
      try {
        const ticks = Math.floor(at / QUARTER_MS) * QUARTER_MS;
        const value = normalizeFlows(await getJson(FLOW_URL(ticks)));
        if (!value.links.length) throw new Error('no flows in the answer');
        flows = { value, at };
      } catch (error) {
        flowsRetryAfter = now() + POWER_GRID_RETRY_AFTER_FAILURE_MS;
        console.warn(`[power-grid] flows failed: ${error?.message || error}`);
      }
    }).promise;
  }

  /**
   * One shared production read for today: the day's points, their latest
   * values, and the day kept for the week. An empty answer is an answer (the
   * new day has no quarter-hours yet); a failure keeps the last and starts
   * the pause.
   */
  function refreshDay() {
    return coalesceProxyRequest(inFlight, 'day', async () => {
      const at = now();
      const date = stockholmDate(at);
      try {
        const points = normalizeProductionDay(
          await getJson(PRODUCTION_URL(date)),
        );
        const held = dayOn(date);
        // An empty answer never drops points already held for the date.
        day =
          !points.length && held?.points.length
            ? { ...held, at }
            : { date, points, latest: latestProduction(points), at };
        if (Number.isFinite(day.latest.total)) lastKnown = day.latest;
        await saveDay(date, points);
      } catch (error) {
        dayRetryAfter = now() + POWER_GRID_RETRY_AFTER_FAILURE_MS;
        console.warn(
          `[power-grid] production failed: ${error?.message || error}`,
        );
      }
    }).promise;
  }

  /**
   * The latest production values: today's answer, else the last known while
   * they are recent (they carry their own time), else none.
   */
  async function latestValues(at) {
    const date = stockholmDate(at);
    const held = dayOn(date);
    if (fresh(held, at)) {
      if (Number.isFinite(held.latest.total)) return held.latest;
      // Just after midnight, in a process that never saw the evening: the
      // last quarter-hour of the day file kept by an earlier run.
      if (!lastKnown && eveRead !== date) {
        eveRead = date;
        const eve = latestProduction((await readDay(stepDate(date, -1))) ?? []);
        if (Number.isFinite(eve.total)) lastKnown = eve;
      }
    }
    return lastKnown && at - lastKnown.at <= STALE_MAX_MS
      ? lastKnown
      : { at: null };
  }

  /** Keep today on disk every quarter-hour once the layer has asked. */
  function armSaver() {
    if (saver) return;
    saver = schedule(() => {
      if (dayDue(now())) refreshDay();
    }, QUARTER_MS);
  }

  /** The flows now, with the latest production beside them. */
  async function gridHandler(json, req) {
    armSaver();
    const at = now();
    const wantFlows = flowsDue(at);
    const wantDay = dayDue(at);
    if (wantFlows || wantDay) {
      if (allow(clientKey(req)))
        await Promise.all([
          wantFlows && refreshFlows(),
          wantDay && refreshDay(),
        ]);
      else if (wantFlows)
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    }
    const end = now();
    if (!flows || end - flows.at > STALE_MAX_MS)
      return json(502, { error: 'power_grid_unavailable' });
    const value = {
      ...flows.value,
      production: await latestValues(end),
      fetchedAt: flows.at,
    };
    if (fresh(flows, end)) return json(200, value);
    return json(200, { ...value, stale: true }, { 'X-Data-Stale': 'true' });
  }

  async function dayHandler(url, json, req) {
    const at = now();
    const date = stockholmDate(at);
    const asked = url.searchParams.get('date') || date;
    if (asked !== date)
      return json(400, { error: 'date_out_of_range', dates: [date] });
    armSaver();
    if (dayDue(at)) {
      if (!allow(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      await refreshDay();
    }
    const end = now();
    const held = dayOn(stockholmDate(end));
    if (!held || end - held.at > STALE_MAX_MS)
      return json(502, { error: 'power_grid_day_unavailable' });
    const value = { date: held.date, points: held.points, fetchedAt: held.at };
    return json(200, fresh(held, end) ? value : { ...value, stale: true });
  }

  /** The last week: kept days from disk, today from the control room. */
  async function weekHandler(json, req) {
    armSaver();
    const at = now();
    if (dayDue(at) && allow(clientKey(req))) await refreshDay();
    const end = now();
    const date = stockholmDate(end);
    const held = dayOn(date);
    const days = [];
    for (let back = WEEK_DAYS - 1; back >= 0; back -= 1) {
      const on = stepDate(date, -back);
      const points = back === 0 && held ? held.points : await readDay(on);
      days.push({ date: on, points: points ?? [] });
    }
    const value = { days, fetchedAt: at };
    return json(200, fresh(held, end) ? value : { ...value, stale: true });
  }

  async function handler(req, res) {
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/day') return dayHandler(url, json, req);
    if (url.pathname === '/week') return weekHandler(json, req);
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    return gridHandler(json, req);
  }

  return {
    name: 'power-grid',
    configureServer({ middlewares }) {
      middlewares.use('/api/power-grid', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/power-grid', handler);
    },
  };
}
