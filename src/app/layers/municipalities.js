import * as Cesium from 'cesium';
import { createMunicipalitiesLayer } from '../../layers/municipalities/index.js';
import * as scenePick from '../../data/scenePick.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the Swedish municipality and county boundaries into the catalog. */
export function createApplicationMunicipalities(options) {
  return createMunicipalitiesLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    scenePick,
    pointer: { isPointerFree },
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
