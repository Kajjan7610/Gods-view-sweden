import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request MCF's shelters in a view through the same-origin proxy. */
export function createSheltersSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{signal?: AbortSignal, bbox: number[], center: number[],
     *   limit?: number}} query
     * @returns {Promise<{shelters: object[], total: number|null,
     *   places: number|null, count: number, tooWide: boolean, stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal, bbox, center, limit = 1500 } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(bbox) || !Array.isArray(center))
        throw new Error(msg('Shelters need a view to show'));
      const round = (value) => Math.round(value * 1e4) / 1e4;
      const query = new URLSearchParams({
        bbox: bbox.map(round).join(','),
        center: center.map(round).join(','),
        limit: String(limit),
      });
      const response = await fetchImpl(`/api/shelters?${query}`, { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(`Shelter data unavailable (HTTP ${response.status})`),
          { status: response.status },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.shelters))
        throw new Error(msg('Malformed shelter snapshot'));
      const num = (value) => (Number.isFinite(value) ? value : null);
      return {
        shelters: payload.shelters,
        total: num(payload.total),
        places: num(payload.places),
        count: num(payload.count) ?? 0,
        tooWide: payload.tooWide === true,
        stale: payload.stale === true,
        fetchedAt: num(payload.fetchedAt),
      };
    },
  };
}
