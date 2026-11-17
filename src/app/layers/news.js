import { createNewsLayer } from '../../layers/news/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the news layer to the application overlay host. */
export function createApplicationNews(options) {
  const layer = createNewsLayer({ overlayHost, ...options });
  // Swedish fork: not offered (its conflict events are not reviewed); the
  // Swedish regional news stays in the cockpit briefing.
  layer.showInTogglePanel = false;
  return layer;
}
