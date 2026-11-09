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
 * Pure — no Cesium.
 */

/** First wait before asking again for rows that only got the geoid stand-in. */
export const GROUND_RETRY_FIRST_MS = 2 * 60_000;
/** Longest wait between such retries. */
export const GROUND_RETRY_MAX_MS = 30 * 60_000;

/**
 * Height above the ellipsoid for each row.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {ReadonlyArray<{id: string, point: [number, number]}>} rows
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Map<string, {height: number, real: boolean}>>} Row id to
 *   metres; `real` when Re:Earth answered rather than the geoid stand-in.
 *   Rows the service could not resolve are left out.
 */
export async function resolveGroundHeights(terrain, rows, { signal } = {}) {
  const heights = new Map();
  if (typeof terrain?.resolveEllipsoidalGround !== 'function' || !rows.length)
    return heights;
  const results = await terrain.resolveEllipsoidalGround(
    rows.map(({ point: [lon, lat] }) => ({ lat, lon })),
    { signal },
  );
  rows.forEach((row, index) => {
    const result = results?.[index];
    if (Number.isFinite(result?.ellipsoid))
      heights.set(row.id, {
        height: result.ellipsoid,
        real: result.source === 'reearth',
      });
  });
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
