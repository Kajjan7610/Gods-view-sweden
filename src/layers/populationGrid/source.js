import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the population squares in a view through the same-origin route. */
export function createPopulationGridSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{bbox: number[], signal?: AbortSignal}} options
     * @returns {Promise<{squares: Array[], level: number, capped: boolean,
     *   year: number|null, built: string|null}>}
     */
    async getSquares({ bbox, signal } = {}) {
      signal?.throwIfAborted();
      const [west, south, east, north] = bbox.map((value) => value.toFixed(4));
      const response = await fetchImpl(
        `/api/population-grid?west=${west}&south=${south}&east=${east}&north=${north}`,
        { signal },
      );
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Population grid unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.squares) || !Number.isInteger(payload.level))
        throw new Error(msg('Malformed population grid'));
      return {
        squares: payload.squares,
        level: payload.level,
        capped: payload.capped === true,
        year: Number.isInteger(payload.year) ? payload.year : null,
        built: typeof payload.built === 'string' ? payload.built : null,
      };
    },
  };
}
