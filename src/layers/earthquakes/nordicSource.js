import { createUsgsEarthquakeSource } from './source.js';

// Swedish fork: USGS's world feed (M2.5 and up, one day) with the EMSC's
// Nordic quakes of the same day, small ones included, from the app's own
// /api/emsc-nordic. Inside the Nordic box the EMSC's list replaces USGS's,
// which it already holds; when the EMSC does not answer, USGS's stands.
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

/** USGS's rows with the Nordic box's taken from the EMSC where it answers. */
export function mergeNordicRows(usgsRows, emscEvents) {
  if (!Array.isArray(emscEvents)) return usgsRows;
  return [
    ...usgsRows.filter((row) => !inBox(row)),
    ...emscEvents.filter(inBox).map(emscRow),
  ];
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
