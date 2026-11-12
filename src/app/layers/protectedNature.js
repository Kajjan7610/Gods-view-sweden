import * as Cesium from 'cesium';
import { createProtectedNatureLayer } from '../../layers/protectedNature/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire Sweden's national parks, nature and culture reserves into the catalog. */
export function createApplicationProtectedNature(options) {
  return createProtectedNatureLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    pointer: { isPointerFree },
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    ...options,
  });
}
