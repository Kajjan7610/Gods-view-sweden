import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated. The view's rows come compact, as
// the route sends them; the layer reads them with records.js, expandTurbine.
const msg = (text) => text;

/** Request Vindbrukskollen's wind turbines, same-origin. */
export function createWindTurbinesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(url, signal, cap) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw Object.assign(
        new Error(`Wind turbines unavailable (HTTP ${response.status})`),
        { status: response.status },
      );
    }
    const payload = await readResponseJsonCapped(response, cap, signal);
    signal?.throwIfAborted();
    return payload;
  }
  const num = (value) => (Number.isFinite(value) ? value : null);

  return {
    /**
     * The turbines in a view, each with what a dot and its name need, in
     * the route's short keys. Without a limit the route's own (WIND_SHOWN).
     * @param {{signal?: AbortSignal, bbox: number[], center: number[],
     *   limit?: number, kinds?: string[]}} query
     * @returns {Promise<{turbines: object[], total: number|null,
     *   builtMW: number|null, counts: object, tooWide: boolean,
     *   capped: boolean, stale: boolean, fetchedAt: number|null,
     *   updated: string|null}>}
     */
    async getSnapshot({ signal, bbox, center, limit, kinds = ['built'] } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(bbox) || !Array.isArray(center))
        throw new Error(msg('Wind turbines need a view to show'));
      const round = (value) => Math.round(value * 1e4) / 1e4;
      const query = new URLSearchParams({
        bbox: bbox.map(round).join(','),
        center: center.map(round).join(','),
        kinds: kinds.join(','),
      });
      if (Number.isFinite(limit)) query.set('limit', String(limit));
      const payload = await read(
        `/api/wind-turbines?${query}`,
        signal,
        2 * 1024 * 1024,
      );
      if (!Array.isArray(payload?.turbines))
        throw new Error(msg('Malformed wind turbine snapshot'));
      const counts = {};
      for (const [kind, count] of Object.entries(payload.counts ?? {}))
        if (Number.isFinite(count)) counts[kind] = count;
      return {
        turbines: payload.turbines,
        total: num(payload.total),
        builtMW: num(payload.builtMW),
        counts,
        tooWide: payload.tooWide === true,
        capped: payload.capped === true,
        stale: payload.stale === true,
        fetchedAt: num(payload.fetchedAt),
        updated:
          typeof payload.updated === 'string' && payload.updated
            ? payload.updated
            : null,
      };
    },

    /**
     * One turbine's full row, for its card.
     * @param {{signal?: AbortSignal, id: string}} query
     * @returns {Promise<object>}
     */
    async getTurbine({ signal, id } = {}) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({ id: String(id ?? '') });
      const payload = await read(
        `/api/wind-turbines/turbine?${query}`,
        signal,
        64 * 1024,
      );
      const row = payload?.turbine;
      if (typeof row?.id !== 'string' || !Array.isArray(row?.point))
        throw new Error(msg('Malformed wind turbine snapshot'));
      return row;
    },
  };
}
