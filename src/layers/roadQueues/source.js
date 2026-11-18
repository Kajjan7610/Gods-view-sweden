import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request Trafikverket's queues and travel times through the same-origin proxy. */
export function createRoadQueuesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{routes: object[], points: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/trafikverket-queues', {
        signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(
            response.status === 503
              ? msg('Queues need the Trafikverket key')
              : `Queue data unavailable (HTTP ${response.status})`,
          ),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.routes) || !Array.isArray(payload?.points))
        throw new Error(msg('Malformed queue snapshot'));
      return {
        routes: payload.routes,
        points: payload.points,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
