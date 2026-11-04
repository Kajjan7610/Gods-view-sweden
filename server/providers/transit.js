import { createTransitService } from '../../src/sources/transitService.js';
import { sharedTrafiklabStatic } from './trafiklabStatic.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

/** Connect the reusable transit request service to development and preview. */
export function transitProxy(options = {}) {
  // Route numbers for the Trafiklab feeds, joined from static GTFS.
  const trafiklabStatic = sharedTrafiklabStatic();
  const service = createTransitService({
    enrichVehicles: trafiklabStatic.enrichVehicles,
    ...options,
  });
  const close = () => {
    service.close();
    trafiklabStatic.close();
  };
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
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
