import { normalizeWarnings } from '../../src/layers/smhiWarnings/records.js';
import { readResponseJsonCapped } from './common/http.js';

// One read of Krisinformation.se and one of SMHI's warning file, shared by
// every part that shows them: the VMA banner and the city dossier
// (krisinformation.js), the weather warnings layer (smhiWarnings.js) and the
// cockpit briefing (regional/sweden.js). Each part keeps its own rule for how
// long an answer that can no longer be confirmed is shown; a feed only says
// when its answer was read and whether the last try succeeded.

// Krisinformation.se (MCF, open data, no key): the VMAs in effect and the
// last days' crisis news.
export const KRISINFORMATION_URL = 'https://api.krisinformation.se/v3';
export const KRIS_NEWS_DAYS = 3;
// SMHI's impact-based weather warnings (CC BY 4.0, no key): one document with
// every warning in effect or upcoming, polygons included.
export const SMHI_WARNINGS_URL =
  'https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json';

const KRIS_TTL_MS = 2 * 60_000;
const WARNINGS_TTL_MS = 5 * 60_000;
/** How long a source is left alone after a failed read. */
export const FEED_RETRY_AFTER_FAILURE_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * A cached, coalesced reader: `read()` answers `{...value, savedAt, fresh}`.
 * Within `ttlMs` of the last good read it is that read; after a failure the
 * last good read with `fresh: false` (no read at all: the error), and the
 * source is left alone for a minute.
 */
function createFeed({ name, load, ttlMs, now }) {
  let kept = null;
  let loading = null;
  let retryAfter = 0;
  let lastError = null;

  function read() {
    if (kept && now() - kept.savedAt < ttlMs)
      return Promise.resolve({ ...kept, fresh: true });
    if (now() < retryAfter)
      return kept
        ? Promise.resolve({ ...kept, fresh: false })
        : Promise.reject(lastError);
    loading ??= load()
      .then((value) => {
        kept = { ...value, savedAt: now() };
        retryAfter = 0;
        return { ...kept, fresh: true };
      })
      .catch((error) => {
        // The message names a status or a host, never more.
        console.warn(`[${name}] read failed: ${error?.message || error}`);
        lastError = error;
        retryAfter = now() + FEED_RETRY_AFTER_FAILURE_MS;
        if (kept) return { ...kept, fresh: false };
        throw error;
      })
      .finally(() => (loading = null));
    return loading;
  }

  return { read };
}

async function getJson(fetchImpl, url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(
        `upstream HTTP ${response.status} (${new URL(url).host})`,
      );
    }
    return await readResponseJsonCapped(response, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Krisinformation's VMAs and news as it answers them (raw rows: each part
 * reads them its own way), kept two minutes.
 */
export function createKrisinformationFeed({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const list = async (path) => {
    const body = await getJson(
      fetchImpl,
      `${KRISINFORMATION_URL}${path}`,
      4 * 1024 * 1024,
    );
    return Array.isArray(body) ? body : [];
  };
  return createFeed({
    name: 'krisinformation',
    ttlMs: KRIS_TTL_MS,
    now,
    load: async () => {
      const [vmas, news] = await Promise.all([
        list('/vmas'),
        list(`/news?days=${KRIS_NEWS_DAYS}`),
      ]);
      return { vmas, news };
    },
  });
}

/**
 * SMHI's warnings, normalized as they are read (the large document is not
 * kept), kept five minutes.
 */
export function createSmhiWarningsFeed({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createFeed({
    name: 'smhi-warnings-feed',
    ttlMs: WARNINGS_TTL_MS,
    now,
    load: async () => ({
      warnings: normalizeWarnings(
        await getJson(fetchImpl, SMHI_WARNINGS_URL, 16 * 1024 * 1024),
        now(),
      ),
    }),
  });
}

let sharedKris = null;
let sharedWarnings = null;

/** The server's one Krisinformation reader. */
export const sharedKrisinformationFeed = () =>
  (sharedKris ??= createKrisinformationFeed());

/** The server's one SMHI warnings reader. */
export const sharedSmhiWarningsFeed = () =>
  (sharedWarnings ??= createSmhiWarningsFeed());
