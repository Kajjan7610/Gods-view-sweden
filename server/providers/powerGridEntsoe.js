import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { sameSiteGated } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import {
  ENTSOE_API_URL,
  ENTSOE_AREAS,
  ENTSOE_LINKS,
  SWEDISH_ZONES,
  entsoeQuery,
  entsoeTime,
  flowsFromEntsoe,
  parseEntsoeSeries,
  productionFromEntsoe,
} from '../../src/layers/powerGrid/entsoe.js';
import { latestProduction } from '../../src/layers/powerGrid/records.js';
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// The power-grid routes (/api/power-grid, /day, /week) from the ENTSO-E
// Transparency Platform. Svenska kraftnät's control-room service is not used:
// Svenska kraftnät answered (2026-11-16) that it is not public and refers to
// ENTSO-E under CC BY 4.0. It needs a free security token in
// ENTSOE_SECURITY_TOKEN (server-side only; it travels in the query string to
// ENTSO-E and is never logged or answered). Only the flows are free to re-use
// (CC BY 4.0); generation and load are read only with ENTSOE_PRODUCTION=on,
// once Svenska kraftnät has consented.
//
// ENTSO-E publishes an hour after the operating period at the latest, so the
// answers are the newest quarter-hour published, not this one. A refresh asks
// for both directions of the 14 links, and with production allowed for
// generation and load in the four Swedish zones over the last week: 28
// requests (36 with production) at most every quarter-hour, well under the 400
// a minute ENTSO-E allows a token. A refresh takes up to about a minute, so an
// answer past its quarter-hour is served at once, marked stale, while one
// refresh runs behind it; only without an answer of the last two hours is the
// refresh waited for. A stale answer says `refreshing` while that refresh
// runs, and the layer then reads once more 90 s on (STALE_REREAD_MS in
// src/layers/powerGrid/index.js) for the fresh one. A failed refresh leaves
// ENTSO-E alone for a minute, and until those reads are in, so they never ask
// ENTSO-E themselves; meanwhile the last answer is served, marked stale, for
// two hours. The last answer is kept on disk, never the token, so a restart
// (a key saved in KOPPLA PÅ) starts from it instead of asking ENTSO-E again;
// one read with another token is left out, so a new token is tried, and a
// refused one said, at once.
/** Production older than this does not stand beside the flows. */
const PRODUCTION_MAX_AGE_MS = 2 * 60 * 60_000;
const TTL_MS = 15 * 60_000;
const STALE_MAX_MS = 2 * 60 * 60_000;
/** Where the last answer is kept across a restart, and its format. */
const CACHE_FILE = path.join(
  defaultSourceRoot,
  '.gev-cache',
  'power-grid-entsoe.json',
);
const CACHE_VERSION = 1;
export const ENTSOE_RETRY_AFTER_FAILURE_MS = 60_000;
/**
 * How long after an answer that said `refreshing` a failed refresh still
 * leaves ENTSO-E alone: the layer's read 90 s on comes within it.
 */
const STALE_REREAD_COVER_MS = 2 * 60_000;
/** Flows are asked for over the last few hours; ENTSO-E lags up to one. */
const FLOW_WINDOW_MS = 4 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
const HOUR_MS = 60 * 60_000;
const STOCKHOLM_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const stockholmDate = (ms) => STOCKHOLM_DATE.format(ms);
/** Days the week route shows, today included. */
export const WEEK_DAYS = 7;

/** A short one-way fingerprint: the saved answer names its token without it. */
const fingerprint = (token) =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

/** A "YYYY-MM-DD" date moved by whole days. */
export function stepDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** Bounded power-grid routes over ENTSO-E, for dev and preview. */
export function powerGridEntsoeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  cachePath = CACHE_FILE,
} = {}) {
  /**
   * The last good answer, as {flows, points, at}; `lacksProduction` when it
   * was saved without the production allowed now.
   */
  let cached = null;
  /** The read of the answer kept on disk, started by the first request. */
  let diskRead = null;
  let saveWarned = false;
  let retryAfter = 0;
  /** Until when the layer's reads after a `refreshing` answer may come. */
  let rereadsUntil = 0;
  /** Whether the last failed refresh was ENTSO-E refusing the token. */
  let tokenRefused = false;
  let keylessLogged = false;
  // ENTSO-E's generation and load are not on its list of data free for
  // re-use: they are read only when Svenska kraftnät has consented
  // (ENTSOE_PRODUCTION=on). Without them the answer is the flows alone.
  const withProduction =
    String(env.ENTSOE_PRODUCTION ?? '')
      .trim()
      .toLowerCase() === 'on';
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function read(token, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const query = entsoeQuery(params);
      query.set('securityToken', token);
      const response = await fetchImpl(`${ENTSOE_API_URL}?${query}`, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/xml' },
      });
      const text = await readResponseTextCapped(response, MAX_BODY_BYTES);
      // "No matching data" comes back as an acknowledgement, at times with a
      // client-error status; it is an empty answer, not a failure.
      if (!response.ok && !/Acknowledgement_MarketDocument/.test(text))
        // Never the URL: it carries the token.
        throw Object.assign(new Error(`upstream HTTP ${response.status}`), {
          status: response.status,
        });
      return parseEntsoeSeries(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run `tasks` with at most CONCURRENCY at a time; results in order. */
  async function pooled(tasks) {
    const results = new Array(tasks.length);
    let next = 0;
    async function worker() {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return results;
  }

  async function load(token) {
    const at = now();
    const end = Math.ceil(at / HOUR_MS) * HOUR_MS;
    const flowStart = Math.floor((at - FLOW_WINDOW_MS) / HOUR_MS) * HOUR_MS;
    // From midnight, Stockholm time, six days back: the week route's days.
    const weekStart =
      Date.parse(`${stepDate(stockholmDate(at), -(WEEK_DAYS - 1))}T00:00:00Z`) -
      2 * HOUR_MS;
    // One border or zone that does not answer is a gap, not the end of the
    // refresh: the others are asked for all the same.
    const failures = [];
    const attempt = async (query) => {
      try {
        return await read(token, query);
      } catch (error) {
        failures.push(error);
        return null;
      }
    };
    const flowTasks = ENTSOE_LINKS.flatMap((link) => [
      [link.id, 'aToB', link.bCode, link.aCode],
      [link.id, 'bToA', link.aCode, link.bCode],
    ]).map(([id, side, inArea, outArea]) => async () => [
      id,
      side,
      await attempt({
        documentType: 'A11',
        in_Domain: inArea,
        out_Domain: outArea,
        periodStart: entsoeTime(flowStart),
        periodEnd: entsoeTime(end),
      }),
    ]);
    const zoneTasks = !withProduction
      ? []
      : SWEDISH_ZONES.flatMap((zone) => [
          async () => [
            zone,
            'generation',
            await attempt({
              documentType: 'A75',
              processType: 'A16',
              in_Domain: ENTSOE_AREAS[zone],
              periodStart: entsoeTime(weekStart),
              periodEnd: entsoeTime(end),
            }),
          ],
          async () => [
            zone,
            'load',
            await attempt({
              documentType: 'A65',
              processType: 'A16',
              outBiddingZone_Domain: ENTSOE_AREAS[zone],
              periodStart: entsoeTime(weekStart),
              periodEnd: entsoeTime(end),
            }),
          ],
        ]);
    const answers = await pooled([...flowTasks, ...zoneTasks]);
    const byLink = new Map();
    const generation = new Map();
    const loads = new Map();
    // A link with a direction unread is left out: netted from the other
    // direction alone it would show a wrong size and way.
    const broken = new Set();
    let productionUnread = false;
    for (const [key, side, series] of answers) {
      if (side === 'generation' || side === 'load') {
        if (series === null) productionUnread = true;
        else (side === 'generation' ? generation : loads).set(key, series);
      } else if (series === null) broken.add(key);
      else {
        const pair = byLink.get(key) ?? { aToB: [], bToA: [] };
        pair[side] = series;
        byLink.set(key, pair);
      }
    }
    for (const key of broken) byLink.delete(key);
    const flows = flowsFromEntsoe(byLink);
    // Nothing at all: the first failure says why (a refused token keeps its
    // status).
    if (!flows.links.length)
      throw failures[0] ?? new Error('no flows in the answer');
    return {
      flows,
      // Production unread this time: the last read stands until it is old.
      points: !withProduction
        ? []
        : productionUnread
          ? (cached?.points ?? [])
          : productionFromEntsoe(generation, loads),
      at,
    };
  }

  /**
   * The answer kept on disk, read once: requests arriving while it is read
   * wait for it, so none of them asks ENTSO-E for what the disk holds.
   * Production stands only if it was read, and is allowed now: without
   * Svenska kraftnät's consent it is never served. Allowed now but not read
   * then, the flows are served at once, marked stale, while a refresh reads
   * it.
   */
  function readDiskOnce(token) {
    diskRead ??= (async () => {
      const unreadable = (why) =>
        console.warn(
          `[power-grid] the saved answer is left out (${why}); ENTSO-E is asked afresh`,
        );
      let saved;
      try {
        saved = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      } catch (error) {
        // No file is the first start; one that cannot be read is said once.
        if (error?.code !== 'ENOENT')
          unreadable(error?.code || error?.name || 'error');
        return;
      }
      if (saved?.v !== CACHE_VERSION) return unreadable('another format');
      if (!Number.isFinite(saved.at) || !Array.isArray(saved.flows?.links))
        return unreadable('unknown format');
      // An answer from a clock ahead of this one would never grow old.
      if (saved.at > now()) return unreadable('saved ahead of this clock');
      // Read with another token: the one set now (a new key saved in KOPPLA
      // PÅ) is tried at once, so a refusal is said at once too.
      if (saved.tokenPrint !== fingerprint(token)) {
        console.log(
          '[power-grid] the saved answer was read with another key; ENTSO-E is asked afresh',
        );
        return;
      }
      const lacksProduction = withProduction && saved.withProduction !== true;
      cached = {
        flows: saved.flows,
        points:
          withProduction && !lacksProduction && Array.isArray(saved.points)
            ? saved.points
            : [],
        at: saved.at,
        lacksProduction,
      };
    })();
    return diskRead;
  }

  /**
   * Keep an answer for the next start, with its token's fingerprint (never
   * the token): written beside the file and moved over it, so a crash never
   * leaves half an answer. Never fails.
   */
  async function save({ at, flows, points }, token) {
    const temp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        temp,
        JSON.stringify({
          v: CACHE_VERSION,
          at,
          flows,
          points,
          withProduction,
          tokenPrint: fingerprint(token),
        }),
        'utf8',
      );
      await fsp.rename(temp, cachePath);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      if (saveWarned) return;
      saveWarned = true;
      console.warn(
        `[power-grid] the last answer could not be saved (${error?.code || 'error'}); it is kept in memory`,
      );
    }
  }

  /** One shared refresh; a failure keeps the last answer and starts the pause. */
  function refresh(token) {
    return coalesceProxyRequest(inFlight, 'entsoe', async () => {
      try {
        cached = await load(token);
        retryAfter = 0;
        tokenRefused = false;
        console.log(
          `[power-grid] ENTSO-E: ${cached.flows.links.length} links, ${withProduction ? `${cached.points.length} quarter-hours of production` : 'flows only'}`,
        );
        // Saved within the one shared refresh, so two saves never overlap.
        await save(cached, token);
      } catch (error) {
        // A minute, and at least until the layer's reads after `refreshing`
        // are in: they find the pause and never ask ENTSO-E themselves.
        retryAfter = Math.max(
          now() + ENTSOE_RETRY_AFTER_FAILURE_MS,
          rereadsUntil,
        );
        tokenRefused = error?.status === 401 || error?.status === 403;
        console.warn(
          `[power-grid] ENTSO-E refresh failed: ${error?.message || error}`,
        );
      }
    }).promise;
  }

  /** Points of one Stockholm date, oldest first. */
  const pointsOn = (date) =>
    (cached?.points ?? []).filter((point) => stockholmDate(point.at) === date);

  /** The newest production, unless it is too old to stand beside the flows. */
  function productionNow() {
    const latest = latestProduction(cached.points);
    return latest &&
      Number.isFinite(latest.at) &&
      now() - latest.at <= PRODUCTION_MAX_AGE_MS
      ? latest
      : { at: null };
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
    if (!['/', '', '/day', '/week'].includes(url.pathname))
      return json(404, { error: 'unknown_route' });
    const token = String(env.ENTSOE_SECURITY_TOKEN ?? '').trim();
    if (!token) {
      if (!keylessLogged) {
        keylessLogged = true;
        console.warn('[power-grid] the power grid needs ENTSOE_SECURITY_TOKEN');
      }
      return json(
        503,
        { error: 'not_configured' },
        { 'Retry-After': '3600', 'X-Data-Backoff': 'not-configured' },
      );
    }
    await readDiskOnce(token);
    let end = now();
    const fresh = cached && !cached.lacksProduction && end - cached.at < TTL_MS;
    if (!fresh && end >= retryAfter) {
      if (!allow(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      // The refresh never rejects. An answer of the last two hours is served
      // at once, marked stale, while it runs; only without one is it waited
      // for, and the answer is then of the time it ended.
      const reload = refresh(token);
      if (!cached || end - cached.at > STALE_MAX_MS) {
        await reload;
        end = now();
      }
    }
    if (!cached || end - cached.at > STALE_MAX_MS)
      return json(502, {
        error: 'power_grid_unavailable',
        keyRefused: tokenRefused,
      });
    const stale = cached.lacksProduction || end - cached.at >= TTL_MS;
    // The layer reads a stale answer once more 90 s on, but only while a
    // refresh runs for it: after a failed one the next poll asks.
    const refreshing = stale && inFlight.has('entsoe');
    if (refreshing)
      rereadsUntil = Math.max(rereadsUntil, end + STALE_REREAD_COVER_MS);
    const mark = (value) =>
      stale
        ? json(
            200,
            { ...value, stale: true, ...(refreshing ? { refreshing } : {}) },
            { 'X-Data-Stale': 'true' },
          )
        : json(200, value);
    const today = stockholmDate(end);
    if (url.pathname === '/day') {
      const asked = url.searchParams.get('date') || today;
      if (asked !== today)
        return json(400, { error: 'date_out_of_range', dates: [today] });
      return mark({
        date: today,
        points: pointsOn(today),
        fetchedAt: cached.at,
        source: 'entsoe',
        productionOffered: withProduction,
      });
    }
    if (url.pathname === '/week') {
      const days = [];
      for (let back = WEEK_DAYS - 1; back >= 0; back -= 1) {
        const date = stepDate(today, -back);
        days.push({ date, points: pointsOn(date) });
      }
      return mark({
        days,
        fetchedAt: cached.at,
        source: 'entsoe',
        productionOffered: withProduction,
      });
    }
    return mark({
      ...cached.flows,
      production: withProduction ? productionNow() : null,
      fetchedAt: cached.at,
      source: 'entsoe',
      productionOffered: withProduction,
    });
  }

  return {
    name: 'power-grid',
    configureServer({ middlewares }) {
      middlewares.use('/api/power-grid', sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/power-grid', sameSiteGated(handler));
    },
  };
}
