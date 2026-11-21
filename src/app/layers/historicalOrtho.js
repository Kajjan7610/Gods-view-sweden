import { createHistoricalOrthoLayer } from '../../layers/historicalOrtho/index.js';
import { createHistoricalOrthoRenderer } from '../../layers/historicalOrtho/rendering.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Wire Lantmäteriet's historical orthophotos ("Då och nu") into the catalog. */
export function createApplicationHistoricalOrtho({ source }) {
  return createHistoricalOrthoLayer({
    source,
    renderer: createHistoricalOrthoRenderer({
      requestRender: governorRequestRender,
      tileTemplate: (layerId) => source.getTileTemplate(layerId),
      credit: source.credit || '© Lantmäteriet (CC0)',
    }),
  });
}
