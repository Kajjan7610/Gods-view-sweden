import * as Cesium from 'cesium';
import { createHeritageRemainsLayer } from '../../layers/heritageRemains/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  cesiumPicking as picking,
  onCesiumViewer,
} from '../../render/cesium/forkViewer.js';

/** Wire Riksantikvarieämbetet's remains into the catalog. */
export function createApplicationHeritageRemains(options) {
  return onCesiumViewer(
    createHeritageRemainsLayer({
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
      openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      ...options,
    }),
  );
}
