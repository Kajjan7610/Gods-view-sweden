import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request zone prices through the same-origin proxy. */
export function createElectricityPricesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{zones: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/electricity-prices', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Electricity prices unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.zones))
        throw new Error(msg('Malformed electricity price snapshot'));
      return {
        zones: payload.zones,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
