import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRID_LEVELS_KM,
  GRID_YEAR,
  decodeLevel,
  levelForBox,
  squareCentre,
  squareRow,
  squaresInView,
} from '../../src/layers/populationGrid/records.js';

// SCB's people per 1 km square in Sweden and the 5, 10 and 25 km sums, built
// by scripts/build-population-grid.mjs (CC0). The app never asks SCB for
// them: the route serves the squares in a view from the bundled file, read
// once. The file keeps a 1 km square as its colour class alone (never its
// count), and a summed square leaves here with its people rounded, so no
// exact small count is ever sent.
export const POPULATION_GRID_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  // Outside src/: the dev server serves src/ as is, and the exact 1 km
  // counts must never leave the server.
  `../data/se_population_grid/population-${GRID_YEAR}.json`,
);
/** The most squares one view gets, nearest its centre first. */
export const MAX_SQUARES = 3000;

/** Each level unpacked once, with its squares' middles in degrees. */
function unpack(snapshot) {
  const levels = new Map();
  for (const km of GRID_LEVELS_KM) {
    const packed = snapshot.levels?.[km];
    if (!Array.isArray(packed?.cells) || !Number.isInteger(packed.width))
      throw new Error(`malformed snapshot: no ${km} km level`);
    // A 1 km level of counts is an old snapshot: never served.
    if (packed.value !== (km === 1 ? 'class' : 'people'))
      throw new Error(
        `malformed snapshot: ${km} km level holds ${packed.value}`,
      );
    const columns = decodeLevel(packed, km);
    const count = columns.values.length;
    const lon = new Float64Array(count);
    const lat = new Float64Array(count);
    for (let index = 0; index < count; index += 1)
      [lon[index], lat[index]] = squareCentre(
        columns.east[index],
        columns.north[index],
        km,
      );
    levels.set(km, { ...columns, lon, lat });
  }
  return levels;
}

/** Route serving the population squares in a view for dev and preview. */
export function populationGridProxy({
  read = () => readFile(POPULATION_GRID_FILE, 'utf8'),
} = {}) {
  /** The snapshot and its unpacked levels, as one promise: two first views read once. */
  let loaded = null;

  function load() {
    loaded ??= (async () => {
      const snapshot = JSON.parse(await read());
      const levels = unpack(snapshot);
      console.log(
        `[population-grid] ${snapshot.squares} squares, ${snapshot.year}`,
      );
      return { snapshot, levels };
    })().catch((error) => {
      // A failed read is tried again by the next view.
      loaded = null;
      throw error;
    });
    return loaded;
  }

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
      const { snapshot, levels } = await load();
      const km = levelForBox(bbox);
      const level = levels.get(km);
      const found = squaresInView(level, bbox, km, MAX_SQUARES + 1);
      return send(200, {
        source: snapshot.source,
        year: snapshot.year,
        referenceDate: snapshot.referenceDate,
        built: snapshot.built,
        level: km,
        capped: found.length > MAX_SQUARES,
        squares: found
          .slice(0, MAX_SQUARES)
          .map((index) =>
            squareRow(
              level.east[index],
              level.north[index],
              level.values[index],
              km,
            ),
          ),
      });
    } catch (error) {
      console.warn(`[population-grid] unavailable: ${error?.message || error}`);
      return send(502, { error: 'population_grid_unavailable' });
    }
  }

  return {
    name: 'population-grid',
    configureServer({ middlewares }) {
      middlewares.use('/api/population-grid', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/population-grid', handler);
    },
  };
}
