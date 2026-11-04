import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request SMHI observations and point forecasts through the same-origin proxy. */
export function createSmhiWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(url, signal, check) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw Object.assign(
        new Error(`SMHI weather unavailable (HTTP ${response.status})`),
        { status: response.status },
      );
    }
    const payload = await readResponseJsonCapped(
      response,
      4 * 1024 * 1024,
      signal,
    );
    signal?.throwIfAborted();
    if (!check(payload))
      throw new Error(msg('Malformed SMHI weather snapshot'));
    return payload;
  }
  return {
    /**
     * @returns {Promise<{stations: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      const payload = await read('/api/smhi-weather', signal, (p) =>
        Array.isArray(p?.stations),
      );
      return {
        stations: payload.stations,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },

    /** The summarised forecast for one point: {next24, days}. */
    async getForecast({ lat, lon, signal } = {}) {
      return read(
        `/api/smhi-weather/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
        signal,
        (p) => p && Array.isArray(p.days),
      );
    },
  };
}
