import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areasInView } from '../../src/layers/protectedNature/records.js';

// Sweden's national parks, nature reserves and culture reserves, built by
// scripts/build-protected-nature.mjs from Naturvårdsverket's open data
// (CC0). The app never asks Naturvårdsverket for them: the route serves the
// areas in a view from the bundled file, read once.
export const PROTECTED_NATURE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_protected_nature/protected-nature.json',
);
/** The most areas one view gets, nearest its centre first. */
export const MAX_AREAS = 1500;
/** A view wider than this (degrees) gets the national parks alone. */
export const WIDE_ABOVE_DEG = 3;

/** Route serving the protected areas in a view for dev and preview. */
export function protectedNatureProxy({
  read = () => readFile(PROTECTED_NATURE_FILE, 'utf8'),
} = {}) {
  let snapshot = null;

  async function handler(req, res) {
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return send(404, { error: 'unknown_route' });
    const bbox = ['west', 'south', 'east', 'north'].map((key) =>
      Number(url.searchParams.get(key)),
    );
    const [west, south, east, north] = bbox;
    if (!bbox.every(Number.isFinite) || west >= east || south >= north)
      return send(400, { error: 'view_box_required' });
    try {
      if (!snapshot) {
        const parsed = JSON.parse(await read());
        if (!Array.isArray(parsed?.areas))
          throw new Error('malformed snapshot');
        snapshot = parsed;
        console.log(`[protected-nature] ${parsed.areas.length} areas`);
      }
      const { areas, wide } = areasInView(snapshot.areas, bbox, {
        limit: MAX_AREAS + 1,
        wideAboveDeg: WIDE_ABOVE_DEG,
      });
      return send(200, {
        source: snapshot.source,
        built: snapshot.built,
        wide,
        capped: areas.length > MAX_AREAS,
        areas: areas.slice(0, MAX_AREAS),
      });
    } catch (error) {
      console.warn(
        `[protected-nature] unavailable: ${error?.message || error}`,
      );
      return send(502, { error: 'protected_nature_unavailable' });
    }
  }

  return {
    name: 'protected-nature',
    configureServer({ middlewares }) {
      middlewares.use('/api/protected-nature', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/protected-nature', handler);
    },
  };
}
