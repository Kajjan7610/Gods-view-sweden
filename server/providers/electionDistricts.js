import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { districtsInView } from '../../src/layers/electionDistricts/records.js';

// The 2026 Riksdag election per election district, built by
// scripts/build-election-districts.mjs from Valmyndigheten's open data (free
// to use with Valmyndigheten credited). The app never asks val.se for it:
// the route serves the districts in a view from the bundled file, read once.
export const ELECTION_DISTRICTS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_election_districts/riksdag-2026.json',
);
/** The most districts one view gets, nearest its centre first. */
export const MAX_DISTRICTS = 1200;
/** A view wider than this (degrees) asks for too much of the country. */
const MAX_SPAN_DEG = 6;

/** Route serving the districts in a view for dev and preview. */
export function electionDistrictsProxy({
  read = () => readFile(ELECTION_DISTRICTS_FILE, 'utf8'),
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
    if (
      !bbox.every(Number.isFinite) ||
      west >= east ||
      south >= north ||
      east - west > MAX_SPAN_DEG ||
      north - south > MAX_SPAN_DEG
    )
      return send(400, { error: 'view_box_required' });
    try {
      if (!snapshot) {
        const parsed = JSON.parse(await read());
        if (!Array.isArray(parsed?.districts))
          throw new Error('malformed snapshot');
        snapshot = parsed;
        console.log(
          `[election-districts] ${parsed.districts.length} districts`,
        );
      }
      const districts = districtsInView(
        snapshot.districts,
        bbox,
        MAX_DISTRICTS + 1,
      );
      return send(200, {
        source: snapshot.source,
        election: snapshot.election,
        built: snapshot.built,
        capped: districts.length > MAX_DISTRICTS,
        districts: districts.slice(0, MAX_DISTRICTS),
      });
    } catch (error) {
      console.warn(
        `[election-districts] unavailable: ${error?.message || error}`,
      );
      return send(502, { error: 'election_districts_unavailable' });
    }
  }

  return {
    name: 'election-districts',
    configureServer({ middlewares }) {
      middlewares.use('/api/election-districts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/election-districts', handler);
    },
  };
}
