import { createPoliceStationsLayer } from '../../layers/policeStations/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire Polisen's police stations into the catalog. */
export function createApplicationPoliceStations(options) {
  return createPoliceStationsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    ...options,
  });
}
