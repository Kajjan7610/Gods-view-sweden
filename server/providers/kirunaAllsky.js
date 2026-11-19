import {
  readResponseBytesCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';

// Swedish fork: the newest picture from the all-sky camera at the Kiruna
// Atmospheric and Geophysical Observatory (IRF, CC BY 4.0), for the city
// dossier's northern lights. The camera takes one picture a minute; the
// server asks for it at most once a minute however many people look.
export const KIRUNA_ALLSKY_URL =
  'https://www.irf.se/alis/allsky/krn/latest_medium.jpeg';
const TTL_MS = 60_000;
/**
 * A picture the camera took longer ago than this is not shown: the camera
 * pauses by day and between seasons, and its file then stays as it was.
 */
const STALE_MAX_MS = 10 * 60_000;
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const JPEG = /^image\/jpe?g/i;
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';

/** Bounded route for the newest camera picture, dev and preview. */
export function kirunaAllskyProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 20, globalMax: 400 });

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(KIRUNA_ALLSKY_URL, {
        signal: controller.signal,
        headers: { Accept: 'image/jpeg', 'User-Agent': USER_AGENT },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`upstream HTTP ${response.status}`);
      }
      const type = response.headers.get('content-type') || '';
      if (!JPEG.test(type)) throw new Error(`not a JPEG: ${type}`);
      // When the camera took it: the file's own time, else the fetch's.
      const modified = Date.parse(response.headers.get('last-modified') ?? '');
      const bytes = await readResponseBytesCapped(
        response,
        MAX_BYTES,
        controller.signal,
      );
      return {
        body: Buffer.from(bytes),
        takenAt: Number.isFinite(modified) ? modified : now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The cached picture while the camera took it recently enough. */
  const current = () =>
    cached && now() - cached.takenAt <= STALE_MAX_MS ? cached : null;

  async function read() {
    if (cached && now() - cached.savedAt < TTL_MS) return current();
    if (now() < retryAfter) return current();
    return coalesceProxyRequest(inFlight, 'allsky', async () => {
      try {
        cached = { ...(await load()), savedAt: now() };
        retryAfter = 0;
      } catch (error) {
        console.warn(`[kiruna-allsky] ${error?.message || error}`);
        retryAfter = now() + RETRY_AFTER_FAILURE_MS;
      }
      return current();
    }).promise;
  }

  async function handler(req, res) {
    if (res.destroyed) return;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      return res.end();
    }
    if (!allow(clientKey(req))) {
      res.writeHead(429, { 'Retry-After': '60' });
      return res.end();
    }
    const picture = await read();
    if (res.destroyed) return;
    if (!picture) {
      res.writeHead(502, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(picture.body.byteLength),
      'Cache-Control': 'private, max-age=60',
      'X-Picture-Age': String(
        Math.max(0, Math.round((now() - picture.takenAt) / 1000)),
      ),
    });
    res.end(picture.body);
  }

  return {
    name: 'kiruna-allsky',
    read,
    configureServer({ middlewares }) {
      middlewares.use('/api/kiruna-allsky', sameSiteGated(handler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/kiruna-allsky', sameSiteGated(handler));
    },
  };
}
