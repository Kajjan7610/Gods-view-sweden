import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The store snapshot built by scripts/build-company-stores.mjs from
// OpenStreetMap (ODbL). The app never queries Overpass for it: the route only
// serves the bundled file, read once.
export const COMPANY_STORES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_company_stores/stores.json',
);

/** Route serving the bundled Swedish retail-chain stores for dev and preview. */
export function companyStoresProxy({
  read = () => readFile(COMPANY_STORES_FILE, 'utf8'),
} = {}) {
  let body = null;

  async function handler(req, res) {
    const send = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
        ...headers,
      });
      res.end(value);
    };
    if (req.method !== 'GET')
      return send(405, JSON.stringify({ error: 'method_not_allowed' }), {
        Allow: 'GET',
      });
    const route = (req.url || '/').split('?')[0];
    if (route !== '/' && route !== '')
      return send(404, JSON.stringify({ error: 'unknown_route' }));
    try {
      if (body === null) {
        const text = await read();
        const snapshot = JSON.parse(text);
        if (!Array.isArray(snapshot?.stores))
          throw new Error('malformed snapshot');
        body = text;
        console.log(`[company-stores] ${snapshot.stores.length} stores`);
      }
      return send(200, body);
    } catch (error) {
      console.warn(`[company-stores] unavailable: ${error?.message || error}`);
      return send(502, JSON.stringify({ error: 'company_stores_unavailable' }));
    }
  }

  return {
    name: 'company-stores',
    configureServer({ middlewares }) {
      middlewares.use('/api/company-stores', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/company-stores', handler);
    },
  };
}
