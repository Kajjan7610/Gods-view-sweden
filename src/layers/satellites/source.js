const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
  // Imaging coverage beyond the UCS May 2023 snapshot, and science probes.
  'resource',
  'weather',
  'planet',
  'sar',
  'science',
]);

/** The UCS pack, loaded on first use (see src/data/ucsSatellites.js). */
async function loadBundledUcs() {
  const { loadUcsSatellites } = await import('../../data/ucsSatellites.js');
  return loadUcsSatellites();
}

/** The imaging-sensor pack, loaded on first use (see src/data/imagingSensors.js). */
async function loadBundledSensors() {
  const { loadImagingSensors } = await import('../../data/imagingSensors.js');
  return loadImagingSensors();
}

/**
 * Whether the proxy answered with its last copy: STALE-ERROR when CelesTrak
 * is down, and (Swedish fork) STALE while the refresh waits its turn.
 */
const lastCopy = (cache) => cache === 'STALE-ERROR' || cache === 'STALE';

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  loadUcs = loadBundledUcs,
  loadSensors = loadBundledSensors,
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      // The proxy serves its last copy, marked STALE-ERROR, when CelesTrak
      // is down.
      const stale = lastCopy(response.headers?.get?.('x-tle-cache'));
      // Swedish fork: and says until when, while CelesTrak's usage policy
      // keeps it from asking (server/providers/space/celestrakUpstream.js),
      // and when it no longer asks, CelesTrak having answered 404.
      const heldUntil = Date.parse(
        response.headers?.get?.('x-celestrak-held-until') ?? '',
      );
      return {
        ok: response.ok,
        status: response.status,
        text,
        stale,
        heldUntil: Number.isFinite(heldUntil) ? heldUntil : null,
        gone: /^\d{3}$/.test(response.headers?.get?.('x-celestrak-gone') ?? ''),
      };
    },

    /**
     * CelesTrak SATCAT records (CSV) for one group: object type, operational
     * status and owner, through the proxy's day-long cache.
     */
    async readSatcat(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak-satcat/${group}`, {
        signal,
      });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      // The proxy serves its last copy, marked STALE-ERROR, when CelesTrak
      // is down.
      const stale = lastCopy(response.headers?.get?.('x-satcat-cache'));
      return { ok: response.ok, status: response.status, text, stale };
    },

    /** The UCS Satellite Database pack, keyed by NORAD number. */
    readUcs() {
      return loadUcs();
    },

    /** The imaging-sensor pack, indexed by NORAD number and name pattern. */
    readSensors() {
      return loadSensors();
    },
  };
}
