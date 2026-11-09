/**
 * Shared steps of the hand-run OpenStreetMap snapshot builds
 * (build-company-stores.mjs, build-hospitals.mjs): Overpass with mirrors and
 * a cache, the country a point lies in, and ground heights from Re:Earth.
 * Run them by hand, never from the app: public Overpass instances are shared.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRing, polygonsContain } from '../../src/data/adminBoundaries.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const USER_AGENT =
  'gods-eye-view-sverige/0.1 (+https://github.com/Kajjan7610/Gods-view-sweden)';
/** A box around Sweden, as Overpass's south,west,north,east. */
export const BOX = '55.0,10.5,69.2,24.2';
const argEndpoint = process.argv.includes('--endpoint')
  ? process.argv[process.argv.indexOf('--endpoint') + 1]
  : null;
// Tried in order; a busy public instance answers 504 and the next is asked.
const ENDPOINTS = [
  (process.env.OVERPASS_UPSTREAMS || '').split(',')[0].trim(),
  argEndpoint,
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter(Boolean);

const AROUND_SWEDEN = ['SWE', 'NOR', 'FIN', 'ALD', 'DNK', 'EST', 'LVA', 'LTU', 'RUS', 'DEU', 'POL'];

/** The countries the box reaches, as decoded polygons by ISO code. */
export async function countries() {
  const pack = JSON.parse(
    await readFile(path.join(ROOT, 'src/data/local_data/natural_earth/countries.json'), 'utf8'),
  );
  const decimals = pack.meta.decimals;
  const byIso = {};
  for (const feature of pack.features) {
    // Every country the box reaches, so a Baltic point is not taken for a
    // Swedish one on the nearest coast.
    if (!AROUND_SWEDEN.includes(feature.iso)) continue;
    byIso[feature.iso] = feature.polygons.map((poly) =>
      poly.map((ring) => decodeRing(ring, decimals)),
    );
  }
  return byIso;
}

/** The country a point belongs to: containing polygon, else nearest vertex. */
export function countryOf(byIso, [lon, lat]) {
  for (const [iso, polygons] of Object.entries(byIso))
    if (polygonsContain(polygons, lat, lon)) return iso;
  let best = null;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (const [iso, polygons] of Object.entries(byIso))
    for (const [outer] of polygons)
      for (const [x, y] of outer) {
        const d = ((x - lon) * cos) ** 2 + (y - lat) ** 2;
        if (!best || d < best.d) best = { iso, d };
      }
  return best?.iso ?? null;
}

const CACHE_MS = 12 * 60 * 60_000;
/** Oldest OSM data an answer may carry; older mirrors are skipped. */
const MAX_LAG_MS = 14 * 24 * 60 * 60_000;

/** A cache of answers in the system temp directory, so a cut run resumes. */
export function createCache(name) {
  const dir = path.join(os.tmpdir(), name);
  const fileOf = (key) =>
    path.join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`);

  async function cached(key) {
    try {
      if (Date.now() - (await stat(fileOf(key))).mtimeMs < CACHE_MS)
        return JSON.parse(await readFile(fileOf(key), 'utf8'));
    } catch {
      // Not cached yet.
    }
    return null;
  }
  async function keep(key, body) {
    await mkdir(dir, { recursive: true });
    await writeFile(fileOf(key), body);
  }

  /** An Overpass query, tried on each mirror in turn. */
  async function overpass(query) {
    const hit = await cached(query);
    if (hit) return hit;
    for (let attempt = 1; attempt <= 3 * ENDPOINTS.length; attempt++) {
      const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
      let status;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240_000),
        });
        const body = await response.text();
        // A mirror that lags months behind answers fine but stale: try another.
        const base = Date.parse(body.match(/"timestamp_osm_base":\s*"([^"]+)"/)?.[1] ?? '');
        if (Number.isFinite(base) && Date.now() - base > MAX_LAG_MS) {
          status = `data from ${new Date(base).toISOString().slice(0, 10)}`;
        } else if (response.ok && body.startsWith('{')) {
          await keep(query, body);
          return JSON.parse(body);
        } else status = `HTTP ${response.status}`;
      } catch (error) {
        status = error?.cause?.code || error?.name || 'network error';
      }
      console.warn(`  ${new URL(endpoint).host} ${status}, attempt ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    throw new Error('Overpass unavailable');
  }

  /** A GET answer as JSON, kept in the cache like the Overpass answers. */
  async function json(url) {
    const hit = await cached(url);
    if (hit) return hit;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(240_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        await keep(url, body);
        return JSON.parse(body);
      } catch (error) {
        if (attempt >= 3) throw error;
        console.warn(`  ${new URL(url).host} ${error.message}, attempt ${attempt}`);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
  }

  /**
   * Ground height above the ellipsoid for each row's `point`, as `height`,
   * so a layer can draw it on the ground without clamping to 3D tiles.
   */
  async function groundHeights(rows) {
    for (let start = 0; start < rows.length; start += 64) {
      const chunk = rows.slice(start, start + 64);
      const points = chunk.map((row) => row.point.map((value) => value.toFixed(5)).join(',')).join(';');
      const answer = await json(
        `https://terrain.reearth.land/heights.json?points=${encodeURIComponent(points)}`,
      );
      chunk.forEach((row, index) => {
        const height = answer.results?.[index]?.ellipsoid;
        if (Number.isFinite(height)) row.height = Math.round(height);
      });
    }
  }

  return { overpass, json, groundHeights };
}
