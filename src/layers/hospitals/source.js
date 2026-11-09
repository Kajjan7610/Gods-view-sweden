import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the bundled hospitals through the same-origin route. */
export function createHospitalsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{hospitals: object[], national: object,
     *   statistics: object|null, osmBase: string|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/hospitals', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Hospital data unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.hospitals))
        throw new Error(msg('Malformed hospital snapshot'));
      const statistics =
        payload.statistics && typeof payload.statistics === 'object'
          ? payload.statistics
          : null;
      return {
        hospitals: payload.hospitals,
        national: statistics?.national || {},
        statistics,
        osmBase: typeof payload.osmBase === 'string' ? payload.osmBase : null,
      };
    },
  };
}
