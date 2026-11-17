import { createLightningStrikesLayer } from '../../layers/lightningStrikes/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { ensureGeoidReady, geoidHeight } from '../../data/geoid.js';

/** Wire DMI's lightning strokes into the catalog. */
export function createApplicationLightningStrikes(options) {
  return createLightningStrikesLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    geoid: { ensureReady: ensureGeoidReady, heightAt: geoidHeight },
    ...options,
  });
}
