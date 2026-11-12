import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the protected areas in a view through the same-origin route. */
export function createProtectedNatureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{bbox: number[], signal?: AbortSignal}} options
     * @returns {Promise<{areas: object[], wide: boolean, capped: boolean,
     *   built: string|null}>}
     */
    async getAreas({ bbox, signal } = {}) {
      signal?.throwIfAborted();
      const [west, south, east, north] = bbox.map((value) => value.toFixed(4));
      const response = await fetchImpl(
        `/api/protected-nature?west=${west}&south=${south}&east=${east}&north=${north}`,
        { signal },
      );
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Protected nature unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.areas))
        throw new Error(msg('Malformed protected nature snapshot'));
      return {
        areas: payload.areas,
        wide: payload.wide === true,
        capped: payload.capped === true,
        built: typeof payload.built === 'string' ? payload.built : null,
      };
    },
  };
}
