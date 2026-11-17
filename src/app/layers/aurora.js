import { createAuroraLayer } from '../../layers/aurora/index.js';

/** Wire NOAA's aurora forecast into the application catalog. */
export function createApplicationAurora(options) {
  return createAuroraLayer({ ...options });
}
