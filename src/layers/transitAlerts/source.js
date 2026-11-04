import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the disruption snapshot through the same-origin proxy. */
export function createTransitAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{stops: object[], pending: string[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/transit-alerts', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(
            response.status === 503
              ? msg('Transit disruptions need TRAFIKLAB_GTFS_RT_KEY')
              : `Transit disruptions unavailable (HTTP ${response.status})`,
          ),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.stops))
        throw new Error(msg('Malformed transit disruption snapshot'));
      return {
        stops: payload.stops,
        pending: Array.isArray(payload.pending) ? payload.pending : [],
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
