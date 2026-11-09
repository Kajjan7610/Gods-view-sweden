import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the bundled retail-chain stores through the same-origin route. */
export function createCompanyStoresSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{stores: object[], companies: object[],
     *   osmBase: string|null, populationYear: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/company-stores', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Store data unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.stores))
        throw new Error(msg('Malformed store snapshot'));
      return {
        stores: payload.stores,
        companies: Array.isArray(payload.companies) ? payload.companies : [],
        osmBase: typeof payload.osmBase === 'string' ? payload.osmBase : null,
        populationYear: Number.isInteger(payload.populationYear)
          ? payload.populationYear
          : null,
      };
    },
  };
}
