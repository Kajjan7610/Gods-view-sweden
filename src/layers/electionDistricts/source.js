import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the election districts in a view through the same-origin route. */
export function createElectionDistrictsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{bbox: number[], signal?: AbortSignal}} options
     * @returns {Promise<{districts: object[], capped: boolean,
     *   source: string|null, election: string|null, built: string|null}>}
     */
    async getDistricts({ bbox, signal } = {}) {
      signal?.throwIfAborted();
      const [west, south, east, north] = bbox.map((value) => value.toFixed(4));
      const response = await fetchImpl(
        `/api/election-districts?west=${west}&south=${south}&east=${east}&north=${north}`,
        { signal },
      );
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Election data unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.districts))
        throw new Error(msg('Malformed election snapshot'));
      const text = (value) => (typeof value === 'string' ? value : null);
      return {
        districts: payload.districts,
        capped: payload.capped === true,
        source: text(payload.source),
        election: text(payload.election),
        built: text(payload.built),
      };
    },
  };
}
