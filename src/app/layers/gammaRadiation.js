import * as Cesium from 'cesium';
import { createGammaRadiationLayer } from '../../layers/gammaRadiation/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  cesiumPicking as picking,
  onCesiumViewer,
} from '../../render/cesium/forkViewer.js';

/** Wire Strålsäkerhetsmyndigheten's gamma stations into the catalog. */
export function createApplicationGammaRadiation(options) {
  return onCesiumViewer(
    createGammaRadiationLayer({
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
