/**
 * Ground heights for layers with many map dots. Clamping thousands of dots
 * with `HeightReference.CLAMP_TO_GROUND` freezes the app over photorealistic
 * 3D tiles: Cesium re-picks every clamped dot inside each tile as it streams
 * in, reading tile geometry back from the GPU (seconds per frame with ~3,000
 * dots, and it goes on while the layer is hidden). A layer that gets its
 * heights here can clamp to terrain only, which is cheap, and keep its own
 * height where the globe is hidden under the 3D tiles.
 *
 * Heights come from the application's terrain service (`/api/terrain/heights`,
 * Re:Earth, disk-cached; bundled geoid math when that fails). Only the height
 * changes: a dot's latitude and longitude are never touched. A geoid
 * stand-in is about sea level, so in the mountains a tilted view would show
 * the dot off its place; those rows are asked again until Re:Earth answers.
 *
 * The terrain route allows a client 90 requests a minute, and a first load of
 * every Swedish layer needs about that many. So all layers share one queue
 * that asks for at most 64 points a second, and Re:Earth heights are kept in
 * this browser: places rarely move, so a later visit asks for nothing.
 * Pure — no Cesium.
 */

/** First wait before asking again for rows that only got the geoid stand-in. */
export const GROUND_RETRY_FIRST_MS = 2 * 60_000;
/** Longest wait between such retries. */
export const GROUND_RETRY_MAX_MS = 30 * 60_000;
/** Points per request, as the terrain route takes them. */
export const GROUND_CHUNK = 64;
/** Shortest wait between two requests, across every layer. */
export const GROUND_REQUEST_GAP_MS = 1000;

const STORE_KEY = 'gev:ground-heights:v1';
const STORE_MAX = 20_000;
const SAVE_DELAY_MS = 2000;

/** The rounded key the terrain route caches a point under. */
const pointKey = ([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/** Re:Earth heights this browser already has, by point. */
let stored = null;
let saveTimer = null;

function store() {
  if (stored) return stored;
  stored = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    for (const [key, height] of Object.entries(raw ? JSON.parse(raw) : {}))
      if (Number.isFinite(height)) stored.set(key, height);
  } catch {
    // Storage may be missing or refuse; heights are asked for again.
  }
  return stored;
}

function remember(key, height) {
  const heights = store();
  heights.delete(key);
  heights.set(key, Math.round(height * 10) / 10);
  while (heights.size > STORE_MAX) heights.delete(heights.keys().next().value);
  if (saveTimer !== null || !globalThis.localStorage) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      globalThis.localStorage.setItem(
        STORE_KEY,
        JSON.stringify(Object.fromEntries(store())),
      );
    } catch {
      // Full or refused: keep them for this visit only.
    }
  }, SAVE_DELAY_MS);
}

/** Forget the heights this browser kept (tests, or a reader clearing data). */
export function clearGroundHeightStore() {
  stored = new Map();
  try {
    globalThis.localStorage?.removeItem(STORE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** One queue for every layer, so their requests stay apart. */
let queue = Promise.resolve();
let lastRequestAt = -Infinity;

function paced(gapMs, ask) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return ask();
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Height above the ellipsoid for each row: kept ones at once, the rest from
 * the terrain service, a chunk at a time through the shared queue.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {ReadonlyArray<{id: string, point: [number, number]}>} rows
 * @param {{signal?: AbortSignal, gapMs?: number}} [options]
 * @returns {Promise<Map<string, {height: number, real: boolean}>>} Row id to
 *   metres; `real` when Re:Earth answered rather than the geoid stand-in.
 *   Rows the service could not resolve are left out.
 */
export async function resolveGroundHeights(
  terrain,
  rows,
  { signal, gapMs = GROUND_REQUEST_GAP_MS } = {},
) {
  const heights = new Map();
  if (typeof terrain?.resolveEllipsoidalGround !== 'function' || !rows.length)
    return heights;
  // Rows that share a place (notices around one town) share one lookup.
  const byKey = new Map();
  for (const row of rows) {
    const key = pointKey(row.point);
    const kept = store().get(key);
    if (kept !== undefined) heights.set(row.id, { height: kept, real: true });
    else if (byKey.has(key)) byKey.get(key).rows.push(row);
    else byKey.set(key, { point: row.point, rows: [row] });
  }
  const places = [...byKey.entries()];
  for (let start = 0; start < places.length; start += GROUND_CHUNK) {
    signal?.throwIfAborted();
    const chunk = places.slice(start, start + GROUND_CHUNK);
    const results = await paced(gapMs, () =>
      terrain.resolveEllipsoidalGround(
        chunk.map(
          ([
            ,
            {
              point: [lon, lat],
            },
          ]) => ({ lat, lon }),
        ),
        { signal },
      ),
    );
    chunk.forEach(([key, place], index) => {
      const result = results?.[index];
      if (!Number.isFinite(result?.ellipsoid)) return;
      const real = result.source === 'reearth';
      if (real) remember(key, result.ellipsoid);
      for (const row of place.rows)
        heights.set(row.id, { height: result.ellipsoid, real });
    });
  }
  return heights;
}

/**
 * Keep one layer's ground heights: ask for the rows without a real height, at
 * most one request at a time, call `onHeights` when a height changed, and ask
 * again later, backing off, while some rows only have the geoid stand-in.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {(heights: Map<string, number>) => void} onHeights
 * @param {object} [timers] Injectable for tests.
 */
export function createGroundHeights(
  terrain,
  onHeights,
  {
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    gapMs = GROUND_REQUEST_GAP_MS,
  } = {},
) {
  const heights = new Map();
  const real = new Set();
  let request = null;
  let rows = [];
  let retryTimer = null;
  let retryMs = GROUND_RETRY_FIRST_MS;

  /** A row with a place but no Re:Earth height yet. */
  const unsettled = (row) =>
    !real.has(row.id) &&
    Number.isFinite(row.point?.[0]) &&
    Number.isFinite(row.point?.[1]);

  function stopRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  async function place(next = rows) {
    rows = next;
    if (request) return;
    const missing = rows.filter(unsettled);
    if (!missing.length) {
      stopRetry();
      retryMs = GROUND_RETRY_FIRST_MS;
      return;
    }
    const controller = new AbortController();
    request = controller;
    try {
      const found = await resolveGroundHeights(terrain, missing, {
        signal: controller.signal,
        gapMs,
      });
      if (controller.signal.aborted) return;
      let changed = false;
      for (const [id, entry] of found) {
        if (heights.get(id) !== entry.height) changed = true;
        heights.set(id, entry.height);
        if (entry.real) real.add(id);
      }
      if (changed) onHeights(heights);
    } catch (error) {
      if (!controller.signal.aborted)
        console.warn('[GroundHeights] lookup failed:', error?.message || error);
    } finally {
      if (request === controller) request = null;
    }
    if (controller.signal.aborted) return;
    stopRetry();
    if (rows.some(unsettled)) {
      retryTimer = setTimer(() => {
        retryTimer = null;
        place();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, GROUND_RETRY_MAX_MS);
    } else retryMs = GROUND_RETRY_FIRST_MS;
  }

  return {
    /** Whether heights can be had at all. */
    enabled: typeof terrain?.resolveEllipsoidalGround === 'function',
    /** The known height of a row, or 0 (the ellipsoid) until it arrives. */
    heightOf: (id) => heights.get(id) ?? 0,
    /** Whether a row's height came from Re:Earth. */
    isReal: (id) => real.has(id),
    /** Ask for the heights of rows without a real one; resolves when done. */
    place: (next) =>
      typeof terrain?.resolveEllipsoidalGround === 'function'
        ? place(next)
        : Promise.resolve(),
    /** Drop a pending lookup and retry; known heights stay. */
    cancel() {
      request?.abort();
      request = null;
      stopRetry();
    },
    /** Forget everything. */
    clear() {
      request?.abort();
      request = null;
      stopRetry();
      retryMs = GROUND_RETRY_FIRST_MS;
      heights.clear();
      real.clear();
      rows = [];
    },
  };
}
