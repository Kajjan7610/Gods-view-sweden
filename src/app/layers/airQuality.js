import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import * as picking from '../../data/pickRegistry.js';
import { inputFor } from '../../input/dispatcher.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Wire air-quality readings and station clicks to the application. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    picking,
    pointer: { isPointerFree },
    input: (viewer) => inputFor(viewer),
    ...options,
  });
}
