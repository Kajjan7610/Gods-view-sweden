import { createPopulationGridLayer } from '../../layers/populationGrid/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire SCB's population per square in Sweden into the catalog. */
export function createApplicationPopulationGrid(options) {
  return createPopulationGridLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
