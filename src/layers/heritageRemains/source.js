import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

const num = (value) => (Number.isFinite(value) ? value : null);
const round = (value) => Math.round(value * 1e4) / 1e4;

/**
 * Request RAÄ's remains and protected buildings in a view, and Sweden's
 * World Heritage sites, through the same-origin proxy.
 */
export function createHeritageRemainsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** One answer of the proxy, read capped; HTTP failures carry `status`. */
  async function read(path, { signal, maxBytes, what }) {
    const response = await fetchImpl(path, { signal });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw Object.assign(
        new Error(`${what} unavailable (HTTP ${response.status})`),
        { status: response.status },
      );
    }
    const payload = await readResponseJsonCapped(response, maxBytes, signal);
    signal?.throwIfAborted();
    return payload;
  }
  const viewQuery = (bbox, center, limit) =>
    new URLSearchParams({
      bbox: bbox.map(round).join(','),
      center: center.map(round).join(','),
      limit: String(limit),
    });

  return {
    /**
     * @param {{signal?: AbortSignal, bbox: number[], center: number[],
     *   limit?: number}} query
     * @returns {Promise<{remains: object[], total: number|null,
     *   tooWide: boolean, capped: boolean, stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal, bbox, center, limit = 1500 } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(bbox) || !Array.isArray(center))
        throw new Error(msg('Remains need a view to show'));
      const query = viewQuery(bbox, center, limit);
      const payload = await read(`/api/heritage-remains?${query}`, {
        signal,
        maxBytes: 2 * 1024 * 1024,
        what: 'Remains',
      });
      if (!Array.isArray(payload?.remains))
        throw new Error(msg('Malformed remains snapshot'));
      return {
        remains: payload.remains,
        total: num(payload.total),
        tooWide: payload.tooWide === true,
        capped: payload.capped === true,
        stale: payload.stale === true,
        fetchedAt: num(payload.fetchedAt),
      };
    },

    /**
     * The protected buildings in a view, and the protection areas of listed
     * buildings touching it.
     * @param {{signal?: AbortSignal, bbox: number[], center: number[],
     *   limit?: number}} query
     * @returns {Promise<{buildings: object[], areas: object[],
     *   total: number|null, tooWide: boolean, capped: boolean,
     *   stale: boolean, fetchedAt: number|null}>}
     */
    async getBuildings({ signal, bbox, center, limit = 1500 } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(bbox) || !Array.isArray(center))
        throw new Error(msg('Buildings need a view to show'));
      const query = viewQuery(bbox, center, limit);
      const payload = await read(`/api/heritage-remains/buildings?${query}`, {
        signal,
        maxBytes: 4 * 1024 * 1024,
        what: 'Protected buildings',
      });
      if (!Array.isArray(payload?.buildings) || !Array.isArray(payload?.areas))
        throw new Error(msg('Malformed buildings snapshot'));
      return {
        buildings: payload.buildings,
        areas: payload.areas,
        total: num(payload.total),
        tooWide: payload.tooWide === true,
        capped: payload.capped === true,
        stale: payload.stale === true,
        fetchedAt: num(payload.fetchedAt),
      };
    },

    /**
     * Sweden's World Heritage sites, whole.
     * @param {{signal?: AbortSignal}} [query]
     * @returns {Promise<{sites: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getWorldHeritage({ signal } = {}) {
      signal?.throwIfAborted();
      const payload = await read('/api/heritage-remains/world-heritage', {
        signal,
        maxBytes: 2 * 1024 * 1024,
        what: 'World Heritage',
      });
      if (!Array.isArray(payload?.sites))
        throw new Error(msg('Malformed World Heritage list'));
      return {
        sites: payload.sites,
        stale: payload.stale === true,
        fetchedAt: num(payload.fetchedAt),
      };
    },
  };
}
