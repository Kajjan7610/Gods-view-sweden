import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTDOOR_MAX_SPAN_DEG,
  boxesMeet,
  decodeLine,
  outdoorInView,
  unpackFacility,
  unpackTrail,
  widenedBox,
} from '../../src/layers/outdoorTrails/records.js';

// Naturvårdsverket's trails and outdoor facilities in protected areas, built
// by scripts/build-outdoor-trails.mjs from its downloadable open data (CC0;
// it welcomes "Källa: Naturvårdsverket"). The app never asks Naturvårdsverket: its WFS
// answered the same box differently from one request to the next. The route
// serves the rows in a view from the bundled files, read once, the nearest
// facilities first and the trails cut and thinned for the view.
const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_outdoor_trails',
);
export const FACILITIES_FILE = path.join(DATA_DIR, 'facilities.json');
export const TRAILS_FILE = path.join(DATA_DIR, 'trails.json');
/** Decoded trail lines kept between views, the most recently used last. */
const DECODED_MAX = 2000;
const MAX_LIMIT = 2000;

const numbers = (value, count) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};
const onEarth = (lon, lat) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

/** Route serving the trails and facilities in a view for dev and preview. */
export function naturvardsverketTrailsProxy({
  read = (file) => readFile(file, 'utf8'),
} = {}) {
  /** Both snapshots, as one promise: two first views read once. */
  let snapshot = null;
  /** Trail id → decoded lines; oldest first. */
  const decoded = new Map();

  function load() {
    snapshot ??= (async () => {
      const [facilityFile, trailFile] = await Promise.all(
        [FACILITIES_FILE, TRAILS_FILE].map(async (file) =>
          JSON.parse(await read(file)),
        ),
      );
      if (
        !Array.isArray(facilityFile?.facilities) ||
        !Array.isArray(trailFile?.trails)
      )
        throw new Error('malformed snapshot');
      const value = {
        built: trailFile.built ?? facilityFile.built ?? null,
        facilities: facilityFile.facilities.map(unpackFacility),
        trails: trailFile.trails.filter(
          (row) => Array.isArray(row?.b) && Array.isArray(row?.g),
        ),
      };
      console.log(
        `[outdoor-trails] ${value.facilities.length} facilities and ${value.trails.length} trails`,
      );
      return value;
    })().catch((error) => {
      // A failed read is tried again by the next view.
      snapshot = null;
      throw error;
    });
    return snapshot;
  }

  /** A snapshot trail with its lines decoded, kept for the next view. */
  function withLines(row) {
    const id = String(row.i);
    let lines = decoded.get(id);
    if (lines) decoded.delete(id);
    else lines = row.g.map(decodeLine).filter((line) => line.length >= 2);
    decoded.set(id, lines);
    while (decoded.size > DECODED_MAX)
      decoded.delete(decoded.keys().next().value);
    return { ...unpackTrail(row), lines };
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [pathname, search = ''] = (req.url || '/').split('?');
    if (pathname !== '/' && pathname !== '')
      return json(404, { error: 'unknown_route' });
    const params = new URLSearchParams(search);
    const bbox = numbers(params.get('bbox'), 4);
    const center = numbers(params.get('center'), 2);
    if (
      !bbox ||
      !center ||
      bbox[0] >= bbox[2] ||
      bbox[1] >= bbox[3] ||
      !onEarth(bbox[0], bbox[1]) ||
      !onEarth(bbox[2], bbox[3]) ||
      !onEarth(...center)
    )
      return json(400, { error: 'bbox_and_center_required' });
    // The layer cuts its box to the span at 1e-4 degrees; the sliver allows
    // for the subtraction's own rounding.
    const widest = OUTDOOR_MAX_SPAN_DEG + 1e-9;
    if (bbox[2] - bbox[0] > widest || bbox[3] - bbox[1] > widest)
      return json(200, { tooWide: true, facilities: [], trails: [] });
    let value;
    try {
      value = await load();
    } catch (error) {
      console.warn(`[outdoor-trails] unavailable: ${error?.message || error}`);
      return json(502, { error: 'trails_unavailable' });
    }
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit')) || 1500),
    );
    const wide = widenedBox(bbox);
    const { trailsCapped, ...view } = outdoorInView(
      {
        facilities: value.facilities,
        trails: value.trails
          .filter((row) => boxesMeet(row.b, wide))
          .map(withLines),
      },
      { bbox, center, limit },
    );
    const built = Date.parse(value.built ?? '');
    return json(200, {
      tooWide: false,
      capped: trailsCapped || view.facilityTotal > view.facilities.length,
      fetchedAt: Number.isFinite(built) ? built : null,
      stale: false,
      ...view,
    });
  }

  return {
    name: 'outdoor-trails',
    configureServer({ middlewares }) {
      middlewares.use('/api/outdoor-trails', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/outdoor-trails', handler);
    },
  };
}
