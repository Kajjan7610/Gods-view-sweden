import * as Cesium from 'cesium';
import { createSubmarineCableLayer } from '../../layers/submarineCables/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire cable source geometry to the application overlay host. */
export function createApplicationCables(options) {
  const layer = createSubmarineCableLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
  // Swedish fork: kept for the code that reads it, never listed; its source
  // has no cables (see bundledSource.js).
  layer.showInTogglePanel = false;
  return layer;
}
