// Swedish fork: which map tiles touch Sweden. The traffic layer's TomTom
// flow proxy leaves those to Trafikverket's own data (the queues layer):
// the app does not meet TomTom's terms, so inside Sweden it never asks
// TomTom. Sweden's outline is Natural Earth's admin-0 polygon the app
// already ships.
import { readFileSync } from 'node:fs';
import { tileToBBox } from '../../src/data/tomtomTiles.js';

const COUNTRIES = new URL(
  '../../src/data/local_data/natural_earth/countries.json',
  import.meta.url,
);
const CACHE_MAX = 4096;

let outline = null;
const verdicts = new Map();

// The pack's rings are integers in 10^-decimals degrees, the first vertex
// absolute and each later one a delta (as adminBoundaries.js reads them;
// kept here so the TomTom proxy stays a small package).
function decodeRing(encoded, decimals) {
  const factor = 10 ** decimals;
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    ring.push([x / factor, y / factor]);
  }
  return ring;
}

/** Even-odd point-in-ring test; ring is [[lon, lat], …]. */
function pointInRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Sweden's rings as [[lon, lat], …] and their common box, read once. */
function sweden() {
  if (outline) return outline;
  const pack = JSON.parse(readFileSync(COUNTRIES, 'utf8'));
  const feature = pack.features.find((entry) => entry.iso === 'SWE');
  const decimals = feature?.d ?? pack.meta?.decimals ?? 3;
  const rings = (feature?.polygons ?? []).map((polygon) =>
    decodeRing(polygon[0], decimals),
  );
  const box = { west: 180, east: -180, south: 90, north: -90 };
  for (const ring of rings)
    for (const [lon, lat] of ring) {
      box.west = Math.min(box.west, lon);
      box.east = Math.max(box.east, lon);
      box.south = Math.min(box.south, lat);
      box.north = Math.max(box.north, lat);
    }
  outline = { rings, box };
  return outline;
}

const overlaps = (a, b) =>
  a.west <= b.east &&
  b.west <= a.east &&
  a.south <= b.north &&
  b.south <= a.north;

/**
 * Whether a tile's box and Sweden share any ground: a vertex of Sweden in the
 * tile, or a corner or the middle of the tile in Sweden.
 * @param {{west: number, east: number, south: number, north: number}} box
 */
export function boxTouchesSweden(box) {
  const { rings, box: bounds } = sweden();
  if (!overlaps(box, bounds)) return false;
  for (const ring of rings)
    for (const [lon, lat] of ring)
      if (
        lon >= box.west &&
        lon <= box.east &&
        lat >= box.south &&
        lat <= box.north
      )
        return true;
  const probes = [
    [box.west, box.south],
    [box.west, box.north],
    [box.east, box.south],
    [box.east, box.north],
    [(box.west + box.east) / 2, (box.south + box.north) / 2],
  ];
  return probes.some(([lon, lat]) =>
    rings.some((ring) => pointInRing(ring, lat, lon)),
  );
}

/** Whether the slippy-map tile z/x/y touches Sweden. */
export function tileTouchesSweden(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let verdict = verdicts.get(key);
  if (verdict === undefined) {
    verdict = boxTouchesSweden(tileToBBox(z, x, y));
    if (verdicts.size >= CACHE_MAX) verdicts.clear();
    verdicts.set(key, verdict);
  }
  return verdict;
}
