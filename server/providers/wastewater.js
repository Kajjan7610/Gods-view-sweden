import { normalizeWastewater } from '../../src/data/wastewater.js';
import { readCappedResponseText, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';

// Swedish fork: respiratory viruses in wastewater, from SLU and SEEC on the
// SciLifeLab Swedish Pathogens Portal (CC BY 4.0, DOI
// 10.17044/scilifelab.14256317). The data file's name carries its date and
// changes with each weekly update, so the dashboard page is read first for
// the current link. No key. Read at most every six hours.
export const WASTEWATER_PAGE_URL =
  'https://www.pathogens.se/dashboards/slu-wastewater/';
const ORIGIN = 'https://www.pathogens.se';
/** The dashboard's data file: "/media/dashboard_data/data_2026-11-16.csv". */
export const DATA_LINK =
  /href="(\/media\/dashboard_data\/data_\d{4}-\d{2}-\d{2}\.csv)"/;
const TTL_MS = 6 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';

/** The current data file's address on the dashboard page, or null. */
export function dataFileUrl(html) {
  const match = DATA_LINK.exec(String(html ?? ''));
  return match ? `${ORIGIN}${match[1]}` : null;
}

/** Bounded wastewater route for dev and preview. */
export function wastewaterProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function getText(url, maxBytes, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(`upstream HTTP ${response.status}`);
    }
    const { tooLarge, text } = await readCappedResponseText(response, maxBytes);
    if (tooLarge) throw new Error('upstream answer too large');
    return text;
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const page = await getText(
        WASTEWATER_PAGE_URL,
        MAX_PAGE_BYTES,
        controller.signal,
      );
      const file = dataFileUrl(page);
      if (!file) throw new Error('no data file on the dashboard page');
      const csv = await getText(file, MAX_CSV_BYTES, controller.signal);
      return { ...normalizeWastewater(csv), file, fetchedAt: now() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function read() {
    if (cached && now() - cached.savedAt < TTL_MS) return cached.value;
    if (now() < retryAfter)
      return cached && now() - cached.savedAt <= STALE_MAX_MS
        ? { ...cached.value, stale: true }
        : null;
    return coalesceProxyRequest(inFlight, 'wastewater', async () => {
      try {
        const value = await load();
        cached = { value, savedAt: now() };
        retryAfter = 0;
        console.log(
          `[wastewater] ${value.plants.length} plants, latest ${value.latestWeek}`,
        );
        return value;
      } catch (error) {
        console.warn(`[wastewater] refresh failed: ${error?.message || error}`);
        retryAfter = now() + RETRY_AFTER_FAILURE_MS;
        return cached && now() - cached.savedAt <= STALE_MAX_MS
          ? { ...cached.value, stale: true }
          : null;
      }
    }).promise;
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const value = await read();
    return value
      ? json(200, value)
      : json(502, { error: 'wastewater_unavailable' });
  }

  return {
    name: 'wastewater-se',
    read,
    configureServer({ middlewares }) {
      middlewares.use('/api/wastewater-se', sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wastewater-se', sameSiteGated(handler));
    },
  };
}
