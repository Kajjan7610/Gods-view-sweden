import * as Cesium from 'cesium';
import { createElectionDistrictsLayer } from '../../layers/electionDistricts/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the 2026 Riksdag election per election district into the catalog. */
export function createApplicationElectionDistricts(options) {
  return createElectionDistrictsLayer({
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
    ...options,
  });
}
