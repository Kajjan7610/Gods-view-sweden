import { createHistoricalOrthoLayer } from '../../layers/historicalOrtho/index.js';
import { createHistoricalOrthoRenderer } from '../../layers/historicalOrtho/rendering.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { createImagerySplit, globeSplitTarget } from '../../ui/imagerySplit.js';

/** Wire Lantmäteriet's historical orthophotos ("Då och nu") into the catalog. */
export function createApplicationHistoricalOrtho({ source }) {
  return createHistoricalOrthoLayer({
    source,
    renderer: createHistoricalOrthoRenderer({
      requestRender: governorRequestRender,
      tileTemplate: (layerId) => source.getTileTemplate(layerId),
      credit: source.credit || '© Lantmäteriet (CC0)',
    }),
    // THEN | NOW: the app's imagery divider over the globe port's split.
    createSplit: createImagerySplit,
    splitTarget: globeSplitTarget,
    requestRender: governorRequestRender,
  });
}
