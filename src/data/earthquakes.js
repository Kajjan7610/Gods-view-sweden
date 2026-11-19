import { createNordicEarthquakeSource } from '../layers/earthquakes/nordicSource.js';
import { createApplicationEarthquakes } from '../app/layers/earthquakes.js';
export * from '../layers/earthquakes/index.js';
/** Wire the standalone source and application overlay owner. */
export function createEarthquakesLayer({
  // Swedish fork: USGS's world with the EMSC's small Nordic quakes.
  source = createNordicEarthquakeSource(),
  ...options
} = {}) {
  return createApplicationEarthquakes({ source, ...options });
}
