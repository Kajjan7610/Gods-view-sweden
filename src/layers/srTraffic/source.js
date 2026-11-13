import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request SR traffic messages through the same-origin proxy. */
export function createSrTrafficSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @returns {Promise<{messages: object[], stale: boolean,
     *   fetchedAt: number|null}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/sr-traffic', { signal });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(
          new Error(
            `SR traffic messages unavailable (HTTP ${response.status})`,
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
      if (!Array.isArray(payload?.messages))
        throw new Error(msg('Malformed SR traffic snapshot'));
      return {
        messages: payload.messages,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}

/**
 * Swedish fork: Sveriges Radio's API terms allow its material "only through
 * linking and/or streaming", and the traffic API is no longer maintained, so
 * the layer is hidden and asks nothing. The code stays for merges and for SR's
 * consent; swap this source for createSrTrafficSource to bring it back.
 */
export function createEmptySrTrafficSource() {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      return { messages: [], stale: false, fetchedAt: null };
    },
  };
}
