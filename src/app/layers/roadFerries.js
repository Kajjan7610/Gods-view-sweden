import * as Cesium from 'cesium';
import { createRoadFerriesLayer } from '../../layers/roadFerries/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  cesiumPicking as picking,
  onCesiumViewer,
} from '../../render/cesium/forkViewer.js';

/** Wire Trafikverket's road ferries into the catalog. */
export function createApplicationRoadFerries(options) {
  return onCesiumViewer(
    createRoadFerriesLayer({
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
