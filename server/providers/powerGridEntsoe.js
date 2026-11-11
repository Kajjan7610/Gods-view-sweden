import { sameSiteGated } from './common/same-site.js';
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
import { WEEK_DAYS, powerGridProxy, stepDate } from './powerGrid.js';

// The power-grid routes (/api/power-grid, /day, /week) from the ENTSO-E
// Transparency Platform instead of Svenska kraftnät's control room. Off unless
// POWER_GRID_SOURCE=entsoe, and then it needs a free security token in
// ENTSOE_SECURITY_TOKEN (server-side only; it travels in the query string to
// ENTSO-E and is never logged or answered).
//
// ENTSO-E publishes an hour after the operating period at the latest, so the
// answers are the newest quarter-hour published, not this one. A refresh asks
// for both directions of the 14 links and for generation and load in the four
// Swedish zones over the last week: 36 requests every quarter-hour, well under
// the 400 a minute ENTSO-E allows a token. A failed refresh leaves ENTSO-E
// alone for a minute and serves the last answer, marked stale, for two hours.
/** Production older than this does not stand beside the flows. */
const PRODUCTION_MAX_AGE_MS = 2 * 60 * 60_000;
const TTL_MS = 15 * 60_000;
const STALE_MAX_MS = 2 * 60 * 60_000;
export const ENTSOE_RETRY_AFTER_FAILURE_MS = 60_000;
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

/** The proxy the server mounts: ENTSO-E when asked for, else the control room. */
export function powerGridProxyFor(env = process.env, options = {}) {
  return String(env.POWER_GRID_SOURCE ?? '')
    .trim()
    .toLowerCase() === 'entsoe'
    ? powerGridEntsoeProxy({ env, ...options })
    : powerGridProxy(options);
}

/** Bounded power-grid routes over ENTSO-E, for dev and preview. */
export function powerGridEntsoeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  /** The last good answer, as {flows, points, at}. */
  let cached = null;
  let retryAfter = 0;
  /** Whether the last failed refresh was ENTSO-E refusing the token. */
  let tokenRefused = false;
  let keylessLogged = false;
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
    const zoneTasks = SWEDISH_ZONES.flatMap((zone) => [
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
      points: productionUnread
        ? (cached?.points ?? [])
        : productionFromEntsoe(generation, loads),
      at,
    };
  }

  /** One shared refresh; a failure keeps the last answer and starts the pause. */
  function refresh(token) {
    return coalesceProxyRequest(inFlight, 'entsoe', async () => {
      try {
        cached = await load(token);
        retryAfter = 0;
        tokenRefused = false;
        console.log(
          `[power-grid] ENTSO-E: ${cached.flows.links.length} links, ${cached.points.length} quarter-hours of production`,
        );
      } catch (error) {
        retryAfter = now() + ENTSOE_RETRY_AFTER_FAILURE_MS;
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
        console.warn(
          '[power-grid] POWER_GRID_SOURCE=entsoe needs ENTSOE_SECURITY_TOKEN',
        );
      }
      return json(
        503,
        { error: 'not_configured' },
        { 'Retry-After': '3600', 'X-Data-Backoff': 'not-configured' },
      );
    }
    const at = now();
    const fresh = cached && at - cached.at < TTL_MS;
    if (!fresh && at >= retryAfter) {
      if (!allow(clientKey(req)))
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      await refresh(token);
    }
    const end = now();
    if (!cached || end - cached.at > STALE_MAX_MS)
      return json(502, {
        error: 'power_grid_unavailable',
        keyRefused: tokenRefused,
      });
    const stale = end - cached.at >= TTL_MS;
    const mark = (value) =>
      stale
        ? json(200, { ...value, stale: true }, { 'X-Data-Stale': 'true' })
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
      });
    }
    if (url.pathname === '/week') {
      const days = [];
      for (let back = WEEK_DAYS - 1; back >= 0; back -= 1) {
        const date = stepDate(today, -back);
        days.push({ date, points: pointsOn(date) });
      }
      return mark({ days, fetchedAt: cached.at, source: 'entsoe' });
    }
    return mark({
      ...cached.flows,
      production: productionNow(),
      fetchedAt: cached.at,
      source: 'entsoe',
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
