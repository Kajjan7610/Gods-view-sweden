import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the power system snapshot through the same-origin proxy. */
export function createPowerGridSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{links: object[], areas: object[], production: object,
     *   updated: number|null, stale: boolean, fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/power-grid', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Power grid unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.links))
        throw new Error(msg('Malformed power grid snapshot'));
      return {
        links: payload.links,
        areas: Array.isArray(payload.areas) ? payload.areas : [],
        production: payload.production || {},
        updated: Number.isFinite(payload.updated) ? payload.updated : null,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },

    /**
     * One Stockholm date's production quarter-hours (today when no date).
     * @param {string|null} date "2026-11-09"
     * @returns {Promise<{date: string, points: object[], stale: boolean}>}
     */
    async getDay(date = null, { signal } = {}) {
      signal?.throwIfAborted();
      const query = date ? `?date=${encodeURIComponent(date)}` : '';
      const response = await fetchImpl(`/api/power-grid/day${query}`, {
        signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Power day unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.points))
        throw new Error(msg('Malformed power day'));
      return {
        date: String(payload.date ?? date ?? ''),
        points: payload.points.filter((point) => Number.isFinite(point?.at)),
        stale: payload.stale === true,
      };
    },

    /**
     * The last seven Stockholm days: the ones the server kept, and today.
     * @returns {Promise<{days: Array<{date: string, points: object[]}>,
     *   stale: boolean}>}
     */
    async getWeek({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/power-grid/week', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Power week unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.days))
        throw new Error(msg('Malformed power week'));
      return {
        days: payload.days.map((day) => ({
          date: String(day?.date ?? ''),
          points: (Array.isArray(day?.points) ? day.points : []).filter(
            (point) => Number.isFinite(point?.at),
          ),
        })),
        stale: payload.stale === true,
      };
    },
  };
}
