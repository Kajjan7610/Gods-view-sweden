import * as Cesium from 'cesium';
import { createTrafikverketWeatherLayer } from '../../layers/roadWeather/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  cesiumPicking as picking,
  onCesiumViewer,
} from '../../render/cesium/forkViewer.js';

/** Wire Trafikverket road weather stations into the application catalog. */
export function createApplicationTrafikverketWeather(options) {
  return onCesiumViewer(
    createTrafikverketWeatherLayer({
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
