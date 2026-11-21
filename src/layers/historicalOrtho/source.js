import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The app's own proxy for Lantmäteriet's historical orthophotos. */
const ROUTE = '/api/historiska-ortofoton';

/**
 * Lantmäteriet's historical orthophotos, same-origin: the proxy's login
 * status and its tile URL template. The Geotorget login stays on the
 * server; the browser only learns whether there is one.
 */
export function createHistoricalOrthoSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    credit: '© Lantmäteriet (CC0)',

    /**
     * Whether the server has a Geotorget login, and whether Lantmäteriet
     * refused it; the day's upstream fetches against the budget.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{hasLogin: boolean, authFailed: boolean,
     *   dailyCount: number|null, budget: number|null, date: string|null}>}
     */
    async getStatus({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(`${ROUTE}/status`, { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(
            `Historical aerial photos unavailable (HTTP ${response.status})`,
          ),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(response, 16 * 1024, signal);
      signal?.throwIfAborted();
      if (typeof payload?.hasLogin !== 'boolean')
        throw new Error(msg('Malformed historical aerial photo status'));
      const num = (value) => (Number.isFinite(value) ? value : null);
      return {
        hasLogin: payload.hasLogin,
        authFailed: payload.authFailed === true,
        dailyCount: num(payload.dailyCount),
        budget: num(payload.budget),
        date:
          typeof payload.date === 'string' && payload.date
            ? payload.date
            : null,
      };
    },

    /**
     * The XYZ template of one tile layer of the proxy's allow-list.
     * @param {string} layerId e.g. `1960`, `bw-1998`, `color-2004`, `meta-1975`.
     */
    getTileTemplate: (layerId) =>
      `${ROUTE}/tile/${encodeURIComponent(layerId)}/{z}/{x}/{y}.png`,
  };
}
