import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the aurora forecast through the same-origin proxy. */
export function createAuroraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{rows: number[][], kp: object|null, stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/aurora', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Aurora forecast unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error(msg('Malformed aurora snapshot'));
      return {
        rows: payload.rows,
        observed: Number.isFinite(payload.observed) ? payload.observed : null,
        forecast: Number.isFinite(payload.forecast) ? payload.forecast : null,
        kp: payload.kp ?? null,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
