import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Krisinformation.se (Swedish fork): the public alerts (VMA, Viktigt
// meddelande till allmänheten) and the crisis news Swedish authorities
// publish through Krisinformation.se's open API (Myndigheten för civilt
// försvar, open data, no key). Read at most every two minutes.

export const KRISINFORMATION_URL = 'https://api.krisinformation.se/v3';
const TTL_MS = 2 * 60_000;
const NEWS_DAYS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const text = (value, max = 400) => {
  const s = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};
const field = (row, name) =>
  row?.[name] ?? row?.[name[0].toUpperCase() + name.slice(1)];

/** "18.06 59.33" or "59.33,18.06"-like coordinates: the first point, or null. */
export function firstPoint(area) {
  const object = field(area, 'coordinateObject');
  const lat = Number(object?.latitude ?? object?.Latitude);
  const lon = Number(object?.longitude ?? object?.Longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon))
    return { lat, lon };
  const match = /(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/.exec(
    String(field(area, 'coordinate') ?? ''),
  );
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  // Sweden: latitude 55–69, longitude 10–25, in whichever order they come.
  return a > 50 ? { lat: a, lon: b } : { lat: b, lon: a };
}

/** One message as the app shows it. */
export function normalizeMessage(row, kind) {
  const headline = text(field(row, 'headline'), 200);
  if (!headline) return null;
  const areas = (Array.isArray(field(row, 'area')) ? field(row, 'area') : [])
    .map((area) => ({
      type: text(field(area, 'type'), 20),
      name: text(field(area, 'description'), 80),
      point: firstPoint(area),
    }))
    .filter((area) => area.name || area.type);
  return {
    id: text(field(row, 'identifier'), 80) ?? headline,
    kind,
    headline,
    preamble: text(field(row, 'preamble'), 600),
    published: Date.parse(String(field(row, 'published') ?? '')) || null,
    updated: Date.parse(String(field(row, 'updated') ?? '')) || null,
    web: /^https:\/\//.test(String(field(row, 'web') ?? ''))
      ? String(field(row, 'web')).slice(0, 300)
      : null,
    sender: text(field(row, 'senderName'), 80),
    areas,
  };
}

/** Bounded Krisinformation route for dev and preview. */
export function krisinformationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let kept = null;
  let loading = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${KRISINFORMATION_URL}${path}`, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const body = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      return Array.isArray(body) ? body : [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function read() {
    if (kept && now() - kept.at < TTL_MS) return kept;
    loading ??= Promise.all([
      getJson('/vmas'),
      getJson(`/news?days=${NEWS_DAYS}`),
    ])
      .then(([vmas, news]) => {
        kept = {
          at: now(),
          vmas: vmas.map((row) => normalizeMessage(row, 'vma')).filter(Boolean),
          news: news
            .map((row) => normalizeMessage(row, 'news'))
            .filter(Boolean)
            .sort((a, b) => (b.published ?? 0) - (a.published ?? 0)),
          stale: false,
        };
        return kept;
      })
      .catch((error) => {
        console.warn(`[krisinformation] ${error?.message}`);
        if (kept) return { ...kept, stale: true };
        throw error;
      })
      .finally(() => (loading = null));
    return loading;
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
    try {
      const { vmas, news, at, stale } = await read();
      return json(200, { vmas, news, updatedAt: at, stale: Boolean(stale) });
    } catch {
      return json(502, { error: 'upstream_failed' });
    }
  }

  return {
    name: 'krisinformation',
    configureServer({ middlewares }) {
      middlewares.use('/api/krisinformation', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/krisinformation', handler);
    },
  };
}
