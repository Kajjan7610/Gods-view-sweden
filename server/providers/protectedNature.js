import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTRA_KINDS,
  areasInView,
  isWideView,
} from '../../src/layers/protectedNature/records.js';

// Sweden's national parks, nature reserves and culture reserves, its Natura
// 2000 areas and the access bans in its protected areas (most of them for
// bird and seal protection), built by scripts/build-protected-nature.mjs from Naturvårdsverket's open
// data (CC0). The app never asks Naturvårdsverket for them: the route serves
// the areas in a view from the bundled files, each read once, the Natura 2000
// and ban files only when a close view first asks for them.
const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_protected_nature',
);
export const PROTECTED_NATURE_FILE = path.join(
  DATA_DIR,
  'protected-nature.json',
);
export const NATURA_2000_FILE = path.join(DATA_DIR, 'natura2000.json');
export const ACCESS_BANS_FILE = path.join(DATA_DIR, 'access-bans.json');
/** The file of each kind kept apart. */
const EXTRA_FILES = Object.freeze({
  n2k: NATURA_2000_FILE,
  ban: ACCESS_BANS_FILE,
});
/** The most areas one view gets, nearest its centre first. */
export const MAX_AREAS = 1500;
/** A view wider than this (degrees) gets the national parks alone. */
export const WIDE_ABOVE_DEG = 3;
/**
 * A view this close (degrees) also gets the Natura 2000 areas and access
 * bans: no more points in the densest such view (some 45 000, Stockholm or
 * Skåne) than a 3° view of the reserves alone had.
 */
export const CLOSE_BELOW_DEG = 2;

/** Route serving the protected areas in a view for dev and preview. */
export function protectedNatureProxy({
  read = (file) => readFile(file, 'utf8'),
} = {}) {
  /**
   * The areas a close view chooses from, built once per set of kinds kept
   * apart that is wanted: no copy of some 12 000 areas per view.
   */
  const combined = new Map();

  async function closeAreas(kinds) {
    const key = kinds.join(',');
    if (!combined.has(key)) {
      const lists = await Promise.all(
        [PROTECTED_NATURE_FILE, ...kinds.map((kind) => EXTRA_FILES[kind])].map(
          async (file) => (await snapshotOf(file)).areas,
        ),
      );
      combined.set(key, Object.freeze(lists.flat()));
    }
    return combined.get(key);
  }

  /** Parsed snapshots by file, as promises: two first views read once. */
  const snapshots = new Map();

  function snapshotOf(file) {
    if (!snapshots.has(file))
      snapshots.set(
        file,
        (async () => {
          const parsed = JSON.parse(await read(file));
          if (!Array.isArray(parsed?.areas))
            throw new Error('malformed snapshot');
          console.log(
            `[protected-nature] ${parsed.areas.length} areas from ${path.basename(file)}`,
          );
          return parsed;
        })().catch((error) => {
          // A failed read is tried again by the next view.
          snapshots.delete(file);
          throw error;
        }),
      );
    return snapshots.get(file);
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
    // The kinds kept apart that the layer has switched off.
    const skip = new Set((url.searchParams.get('skip') || '').split(','));
    try {
      const snapshot = await snapshotOf(PROTECTED_NATURE_FILE);
      const close = !isWideView(bbox, CLOSE_BELOW_DEG);
      const { areas, wide } = areasInView(
        close
          ? await closeAreas(EXTRA_KINDS.filter((kind) => !skip.has(kind)))
          : snapshot.areas,
        bbox,
        {
          limit: MAX_AREAS + 1,
          wideAboveDeg: WIDE_ABOVE_DEG,
          closeBelowDeg: CLOSE_BELOW_DEG,
        },
      );
      return send(200, {
        source: snapshot.source,
        built: snapshot.built,
        wide,
        close,
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
