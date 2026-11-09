import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the bundled municipality and county boundaries through the same-origin route. */
export function createMunicipalitiesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{lines: object[], municipalities: object[],
     *   counties: object[], populationPeriod: string|null,
     *   osmBase: string|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/municipalities', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Boundary data unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (
        !Array.isArray(payload?.lines) ||
        !Array.isArray(payload?.municipalities) ||
        !Array.isArray(payload?.counties)
      )
        throw new Error(msg('Malformed boundary snapshot'));
      const text = (value) => (typeof value === 'string' ? value : null);
      return {
        lines: payload.lines,
        municipalities: payload.municipalities,
        counties: payload.counties,
        populationPeriod: text(payload.populationPeriod),
        populationYearAgo: text(payload.populationYearAgo),
        osmBase: text(payload.osmBase),
      };
    },
  };
}
