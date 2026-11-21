import { createWindTurbinesLayer } from '../../layers/windTurbines/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire Länsstyrelserna's Vindbrukskollen wind turbines into the catalog. */
export function createApplicationWindTurbines(options) {
  return createWindTurbinesLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
