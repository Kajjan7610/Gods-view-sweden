import { createUsgsEarthquakeSource } from './source.js';

// Swedish fork: USGS's world feed (M2.5 and up, one day) with the EMSC's
// Nordic quakes of the same day, small ones included, from the app's own
// /api/emsc-nordic. Inside the box a USGS quake the EMSC also lists is drawn
// once, from the EMSC; one the EMSC lacks (newer than its answer, or typed
// otherwise) stays from USGS.
const EMSC_ROUTE = '/api/emsc-nordic';
/** The box the server asks the EMSC about (server/providers/emscNordic.js). */
const NORDIC_BOX = Object.freeze({
  minlat: 54,
  maxlat: 72,
  minlon: 4,
  maxlon: 33,
});

const inBox = ({ lat, lon }) =>
  lat >= NORDIC_BOX.minlat &&
  lat <= NORDIC_BOX.maxlat &&
  lon >= NORDIC_BOX.minlon &&
  lon <= NORDIC_BOX.maxlon;

/** One EMSC event as the layer's row: "Southern Sweden (EMSC, ML)". */
export function emscRow(event) {
  return {
    stableId: `emsc:${event.id}`,
    usgsId: null,
    lon: event.lon,
    lat: event.lat,
    depthKm: event.depthKm ?? null,
    mag: event.mag,
    place: `${event.region || 'Nordic'} (EMSC${event.magType ? `, ${event.magType}` : ''})`,
    time: event.time,
  };
}

/** The same quake in both lists: within two minutes and 100 km. */
const SAME_SECONDS = 120;
const SAME_KM = 100;
const kmBetween = (a, b) => {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** USGS's rows and the EMSC's in the box, each quake once. */
export function mergeNordicRows(usgsRows, emscEvents) {
  if (!Array.isArray(emscEvents)) return usgsRows;
  const emsc = emscEvents.filter(inBox);
  const listed = (row) =>
    inBox(row) &&
    emsc.some(
      (event) =>
        Math.abs(event.time - row.time) <= SAME_SECONDS * 1000 &&
        kmBetween(event, row) <= SAME_KM,
    );
  return [...usgsRows.filter((row) => !listed(row)), ...emsc.map(emscRow)];
}

export function createNordicEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  usgs = createUsgsEarthquakeSource({ fetchImpl }),
} = {}) {
  async function emscEvents(signal) {
    try {
      const response = await fetchImpl(EMSC_ROUTE, { signal });
      if (!response.ok) return null;
      const body = await response.json();
      return Array.isArray(body?.events) ? body.events : null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }
  return {
    async getSnapshot({ signal } = {}) {
      const [rows, events] = await Promise.all([
        usgs.getSnapshot({ signal }),
        emscEvents(signal),
      ]);
      signal?.throwIfAborted();
      return mergeNordicRows(rows, events);
    },
  };
}
