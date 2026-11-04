import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request road weather stations through the same-origin Trafikverket proxy. */
export function createTrafikverketWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{stations: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/trafikverket-weather', { signal });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const notConfigured = detail?.error === 'not_configured';
        throw Object.assign(
          new Error(
            notConfigured
              ? msg(
                  'Trafikverket key not configured (set TRAFIKVERKET_API_KEY)',
                )
              : detail?.keyRefused
                ? msg(
                    'Trafikverket refused the key (check TRAFIKVERKET_API_KEY)',
                  )
                : `Trafikverket feed unavailable (HTTP ${response.status})`,
          ),
          { status: response.status, notConfigured },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.stations))
        throw new Error(msg('Malformed Trafikverket road weather snapshot'));
      return {
        stations: payload.stations,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
