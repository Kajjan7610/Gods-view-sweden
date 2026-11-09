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
 * Re:Earth, disk-cached; bundled geoid math when that fails). Pure — no
 * Cesium.
 */

/**
 * Height above the ellipsoid for each row without one yet.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {ReadonlyArray<{id: string, point: [number, number]}>} rows
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Map<string, number>>} Row id to metres; rows the service
 *   could not resolve are left out.
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
    const height = results?.[index]?.ellipsoid;
    if (Number.isFinite(height)) heights.set(row.id, height);
  });
  return heights;
}

/**
 * Keep one layer's ground heights: ask for the rows still missing one, at
 * most one request at a time, and call `onHeights` when some arrived.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {(heights: Map<string, number>) => void} onHeights
 */
export function createGroundHeights(terrain, onHeights) {
  const heights = new Map();
  let request = null;
  return {
    /** Whether heights can be had at all. */
    enabled: typeof terrain?.resolveEllipsoidalGround === 'function',
    /** The known height of a row, or 0 (the ellipsoid) until it arrives. */
    heightOf: (id) => heights.get(id) ?? 0,
    /** Ask for the heights of rows that have none; resolves when done. */
    async place(rows) {
      if (request) return;
      const missing = rows.filter((row) => !heights.has(row.id));
      if (!missing.length) return;
      const controller = new AbortController();
      request = controller;
      try {
        const found = await resolveGroundHeights(terrain, missing, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        for (const [id, height] of found) heights.set(id, height);
        if (found.size) onHeights(heights);
      } catch (error) {
        if (!controller.signal.aborted)
          console.warn(
            '[GroundHeights] lookup failed:',
            error?.message || error,
          );
      } finally {
        if (request === controller) request = null;
      }
    },
    /** Drop a pending lookup; known heights stay. */
    cancel() {
      request?.abort();
      request = null;
    },
    /** Forget everything. */
    clear() {
      request?.abort();
      request = null;
      heights.clear();
    },
  };
}
