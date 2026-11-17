import * as Cesium from 'cesium';
import { createPowerGridLayer } from '../../layers/powerGrid/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { onCesiumViewer } from '../../render/cesium/forkViewer.js';

/** Wire Sweden's power flows (ENTSO-E) into the application catalog. */
export function createApplicationPowerGrid(options) {
  return onCesiumViewer(
    createPowerGridLayer({
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
      requestRender: governorRequestRender,
      ...options,
    }),
  );
}
