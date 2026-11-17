import { createAuroraLayer } from '../../layers/aurora/index.js';
import { onCesiumViewer } from '../../render/cesium/forkViewer.js';

/** Wire NOAA's aurora forecast into the application catalog. */
export function createApplicationAurora(options) {
  return onCesiumViewer(createAuroraLayer({ ...options }));
}
