import { createTransitService } from '../../src/sources/transitService.js';
import { resolveTransitRoute } from '../../src/data/transitProxy.js';
import { sharedTrafiklabStatic } from './trafiklabStatic.js';
import {
  createTransitShapesHandler,
  isTransitShapesRequest,
} from './trafiklabShapes.js';
import { admitSameSite } from './common/same-site.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

/**
 * Swedish fork: the feed a transit request names, read as the transit
 * service reads it: the same URL (`http://localhost/api/transit` + the
 * request path), the same parser and resolveTransitRoute. A spelling the
 * service accepts (an encoded character, a dot segment, a backslash)
 * therefore names the same feed here.
 * @param {string|undefined} requestUrl The request URL after the mount.
 * @returns {object|null}
 */
function requestedTransitFeed(requestUrl) {
  let url;
  try {
    url = new URL(`http://localhost/api/transit${requestUrl || '/'}`);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith('/api/transit/')) return null;
  return (
    resolveTransitRoute(url.pathname.slice('/api/transit'.length) + url.search)
      ?.feed ?? null
  );
}

/** Connect the reusable transit request service to development and preview. */
export function transitProxy(options = {}) {
  // Route numbers for the Trafiklab feeds, joined from static GTFS.
  const trafiklabStatic = sharedTrafiklabStatic();
  const service = createTransitService({
    enrichVehicles: trafiklabStatic.enrichVehicles,
    ...options,
  });
  // Swedish fork: the Trafiklab feeds' route shapes, from the static GTFS
  // cache only (trafiklabShapes.js): a shapes request never downloads.
  const shapes = createTransitShapesHandler({
    cachedShapes: options.cachedShapes ?? trafiklabStatic.cachedShapes,
  });
  const close = () => {
    service.close();
    trafiklabStatic.close();
  };
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
      // Swedish fork: `/api/transit/shapes` (trafiklabShapes.js).
      if (isTransitShapesRequest(req.url)) return shapes(req, res);
      // Swedish fork: a feed that spends a key (Trafikverket's trains, the
      // Trafiklab operators) answers the app's own page only, however the
      // request spells its id; keyless feeds answer as before.
      if (requestedTransitFeed(req.url)?.requiresKey && admitSameSite(req, res))
        return;
      const response = await service.handle({
        url: `http://localhost/api/transit${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', close);
  }
  return {
    name: 'transit-proxy',
    closeBundle: close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
