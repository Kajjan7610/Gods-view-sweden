import * as Cesium from 'cesium';
import { createTransitAlertsLayer } from '../../layers/transitAlerts/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  cesiumPicking as picking,
  onCesiumViewer,
} from '../../render/cesium/forkViewer.js';

/** Wire Swedish public-transport disruptions into the application catalog. */
export function createApplicationTransitAlerts(options) {
  return onCesiumViewer(
    createTransitAlertsLayer({
      overlayHost: {
        setEntries: overlays.setOverlayEntries,
        setVisible: overlays.setOverlaySourceVisible,
        clearSource: overlays.clearOverlaySource,
        hitTest: overlays.hitTestWorldOverlay,
      },
      screenSpaceEventHandlerFactory: (viewer) =>
        new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
      picking,
      pointer: { isPointerFree },
      ...options,
    }),
  );
}
