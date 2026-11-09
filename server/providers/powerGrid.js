import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeFlows,
  normalizeProduction,
  normalizeProductionDay,
} from '../../src/layers/powerGrid/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Svenska kraftnät's control room (no key): the data service behind
// svk.se/om-kraftsystemet/kontrollrummet. map/flow answers the latest
// quarter-hour flow on every Nordic link; production answers the day's
// quarter-hours per type for Sweden. Both change every quarter-hour, so two
// requests at most every five minutes, and only while the layer asks. The
// service refuses requests that do not look like they come from its page.
//
// Production answers the current day only (an earlier date is a 403), so
// for the week the server keeps each day it has seen on disk. Once the layer
// has asked, it also fetches the day every quarter of an hour while it runs,
// so a day is whole even when nobody watched it end.
export const FLOW_URL = (ticks) =>
  `https://www.svk.se/services/controlroom/v2/map/flow?ticks=${ticks}`;
export const PRODUCTION_URL = (date) =>
  `https://www.svk.se/services/controlroom/v2/production?date=${date}&countryCode=SE`;
const TTL_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const QUARTER_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
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

/** "2026-11-04": the Stockholm calendar date of `ms`. */
function stockholmDate(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
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
  let cached = null;
  const inFlight = new Map();
  /** Today's quarter-hours, as {value, savedAt}. */
  let today = null;
  /** Points on disk per date, so a shorter answer never overwrites a longer. */
  const stored = new Map();
  let saver = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function getJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
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
    return readResponseJsonCapped(response, MAX_BODY_BYTES);
  }

  /** Keep a day's quarter-hours on disk; drop days past the week. */
  async function saveDay(date, points) {
    if (!points.length || points.length < (stored.get(date) ?? 0)) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        path.join(cacheDir, `${date}.json`),
        JSON.stringify({ date, points }),
      );
      stored.set(date, points.length);
      const oldest = stockholmDate(now() - (KEEP_DAYS - 1) * DAY_MS);
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

  /** Today's production answer: the latest values, and kept for the week. */
  async function loadProduction(at, signal) {
    const date = stockholmDate(at);
    const raw = await getJson(PRODUCTION_URL(date), signal);
    const points = normalizeProductionDay(raw);
    if (points.length) {
      today = { value: { date, points, fetchedAt: at }, savedAt: at };
      await saveDay(date, points);
    }
    return normalizeProduction(raw);
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const at = now();
      const ticks = Math.floor(at / QUARTER_MS) * QUARTER_MS;
      const [flows, production] = await Promise.all([
        getJson(FLOW_URL(ticks), controller.signal).then(normalizeFlows),
        loadProduction(at, controller.signal)
          // Just after midnight the new day has no quarter-hours yet.
          .then((latest) =>
            Number.isFinite(latest.total)
              ? latest
              : getJson(
                  PRODUCTION_URL(stockholmDate(at - DAY_MS)),
                  controller.signal,
                ).then(normalizeProduction),
          ),
      ]);
      if (!flows.links.length) throw new Error('no flows in the answer');
      return { ...flows, production, fetchedAt: at };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Today's quarter-hours, fetched at most every five minutes. */
  async function loadToday() {
    if (today && now() - today.savedAt < TTL_MS) return today.value;
    const { promise } = coalesceProxyRequest(inFlight, 'day', async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const at = now();
        await loadProduction(at, controller.signal);
        return today?.value ?? { date: stockholmDate(at), points: [] };
      } finally {
        clearTimeout(timer);
      }
    });
    return promise;
  }

  /** Keep today on disk every quarter-hour once the layer has asked. */
  function armSaver() {
    if (saver) return;
    saver = schedule(() => {
      loadToday().catch((error) =>
        console.warn(
          `[power-grid] background day failed: ${error?.message || error}`,
        ),
      );
    }, QUARTER_MS);
  }

  async function dayHandler(url, json, req) {
    const date = stockholmDate(now());
    const asked = url.searchParams.get('date') || date;
    if (asked !== date)
      return json(400, { error: 'date_out_of_range', dates: [date] });
    armSaver();
    const fresh = today && now() - today.savedAt < TTL_MS;
    if (!fresh && !allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      return json(200, await loadToday());
    } catch (error) {
      console.warn(
        `[power-grid] day ${date} failed: ${error?.message || error}`,
      );
      if (today) return json(200, { ...today.value, stale: true });
      return json(502, { error: 'power_grid_day_unavailable' });
    }
  }

  /** The last week: kept days from disk, today from the control room. */
  async function weekHandler(json, req) {
    armSaver();
    const at = now();
    const dates = Array.from({ length: WEEK_DAYS }, (_, i) =>
      stockholmDate(at - (WEEK_DAYS - 1 - i) * DAY_MS),
    );
    const fresh = today && now() - today.savedAt < TTL_MS;
    let todayPoints = today?.value.points ?? null;
    if (!fresh && allow(clientKey(req)))
      try {
        todayPoints = (await loadToday()).points;
      } catch (error) {
        console.warn(
          `[power-grid] week today failed: ${error?.message || error}`,
        );
      }
    const days = [];
    for (const date of dates) {
      const points =
        date === dates.at(-1)
          ? (todayPoints ?? (await readDay(date)))
          : await readDay(date);
      days.push({ date, points: points ?? [] });
    }
    return json(200, { days, fetchedAt: at });
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
    armSaver();
    if (cached && now() - cached.savedAt < TTL_MS)
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'grid', load);
      const value = await promise;
      cached = { value, savedAt: now() };
      return json(200, value);
    } catch (error) {
      console.warn(`[power-grid] refresh failed: ${error?.message || error}`);
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      return json(502, { error: 'power_grid_unavailable' });
    }
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
