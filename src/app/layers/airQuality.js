import * as Cesium from 'cesium';
import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import * as picking from '../../data/pickRegistry.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';
/** Wire air-quality readings and station clicks to the application. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
