import { createGhostMapsLayer } from '../../layers/ghostMaps/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire the S2 Underground GhostMaps layer into the application catalog. */
export function createApplicationGhostMaps(options) {
  const layer = createGhostMapsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    ...options,
  });
  // Swedish fork: S2 GhostMaps is CC BY-NC-SA and carries a military
  // situation picture ("Kinetic Activity"), like the military layers the
  // fork removed; kept for merges, never listed.
  layer.showInTogglePanel = false;
  return layer;
}
