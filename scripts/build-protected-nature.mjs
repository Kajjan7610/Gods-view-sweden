#!/usr/bin/env node
/**
 * Build the protected-nature snapshot read by /api/protected-nature:
 *
 *   src/data/local_data/se_protected_nature/protected-nature.json
 *
 * Naturvårdsverket's Naturvårdsregistret as open data (CC0, "Källa:
 * Naturvårdsverket" asked for; "Naturvårdsregistret – beskrivning av öppna
 * data", edition 1.2): the national parks (NP), the nature reserves in force
 * (NR) and the culture reserves (KR), shapefiles in SWEREF 99 TM. Water
 * protection areas and the other forms are left out on purpose: they would
 * map the drinking-water intakes, or add thousands of tiny areas. Each ring
 * is turned into WGS 84, simplified (Douglas–Peucker, from 5 m for a small
 * area to 50 m for a large one) and delta-encoded like the municipality
 * snapshot.
 *
 * Run it by hand now and then, never from the app. The zips are downloaded
 * once into .gev-cache/protected-nature/, or read from a folder.
 *
 * Usage:
 *   node scripts/build-protected-nature.mjs [--from <folder with NP.zip, NR.zip, KR.zip>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDbf, readShpPolygons, zipEntries } from './lib/shapefile.mjs';
import {
  encodeLine,
  polygonsBounds,
  sweref99tmToWgs84,
} from '../src/layers/electionDistricts/records.js';
import { simplifyLine } from '../src/layers/municipalities/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(
  ROOT,
  'src/data/local_data/se_protected_nature/protected-nature.json',
);
const CACHE = path.join(ROOT, '.gev-cache', 'protected-nature');
const BASE = 'https://geodata.naturvardsverket.se/nedladdning/naturvardsregistret/';
/** The forms kept, by file, with the kind the layer knows them by. */
const FORMS = Object.freeze([
  ['NP', 'np'],
  ['NR', 'nr'],
  ['KR', 'kr'],
]);
const TOLERANCE_MIN_M = 5;
const TOLERANCE_MAX_M = 50;
const round5 = (value) => Math.round(value * 1e5) / 1e5;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

/** A form's zip: from the given folder, the cache, or Naturvårdsverket. */
async function zipFor(file) {
  const from = argument('--from');
  if (from) return new Uint8Array(await readFile(path.join(from, `${file}.zip`)));
  const cached = path.join(CACHE, `${file}.zip`);
  if (existsSync(cached)) return new Uint8Array(await readFile(cached));
  console.log(`Downloading ${BASE}${file}.zip`);
  const response = await fetch(`${BASE}${file}.zip`, {
    headers: {
      'User-Agent':
        'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)',
    },
  });
  if (!response.ok) throw new Error(`${file}.zip: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, bytes);
  return bytes;
}

/** Simplify an area by a 150th of its size, within the bounds (m). */
function toleranceFor(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const rings of polygons)
    for (const [x, y] of rings[0] ?? []) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  const size = Math.hypot(e - w, n - s);
  return Math.min(TOLERANCE_MAX_M, Math.max(TOLERANCE_MIN_M, size / 150));
}

const areas = [];
const counts = {};
for (const [file, kind] of FORMS) {
  const entries = zipEntries(await zipFor(file), ['.shp', '.dbf', '.prj', '.cpg']);
  const part = (suffix) =>
    [...entries].find(([name]) => name.toLowerCase().endsWith(suffix))?.[1];
  const prj = new TextDecoder().decode(part('.prj') ?? new Uint8Array());
  if (!/SWEREF99_TM/.test(prj)) throw new Error(`${file}: not SWEREF 99 TM`);
  const cpg = new TextDecoder().decode(part('.cpg') ?? new Uint8Array()).trim();
  const records = readDbf(part('.dbf'), /1252/.test(cpg) ? 'windows-1252' : 'utf-8');
  const shapes = readShpPolygons(part('.shp'));
  if (records.length !== shapes.length)
    throw new Error(`${file}: ${records.length} records, ${shapes.length} shapes`);
  counts[kind] = 0;
  records.forEach((record, index) => {
    const shape = shapes[index];
    // Only areas in force: a decision not yet final, or appealed, may change.
    if (!record || !shape || record.BESLSTATUS !== 'Gällande') return;
    const tolerance = toleranceFor(shape);
    const decoded = shape
      .map((rings) =>
        rings
          .map((ring) =>
            simplifyLine(ring.map((point) => sweref99tmToWgs84(point)), tolerance),
          )
          .filter((ring) => ring.length >= 4),
      )
      .filter((rings) => rings.length && rings[0].length >= 4);
    if (!decoded.length) return;
    const year = Number(String(record.URSGALLDAT ?? '').slice(0, 4));
    areas.push({
      i: String(record.NVRID),
      n: String(record.NAMN ?? '').slice(0, 100),
      t: kind,
      ...(year > 1900 ? { y: year } : {}),
      k: String(record.KOMMUN ?? '').slice(0, 100),
      ...(Number.isFinite(record.AREA_HA) ? { h: Math.round(record.AREA_HA) } : {}),
      b: polygonsBounds(decoded).map(round5),
      g: decoded.map((rings) => rings.map((ring) => encodeLine(ring))),
    });
    counts[kind] += 1;
  });
}

if (counts.np < 25 || counts.nr < 5000)
  throw new Error(`Too few areas: ${JSON.stringify(counts)}`);
// An outline whose box cannot hold the registered area lost its outer ring.
const boxHectares = ([w, s, e, n]) =>
  (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.57 * 100;
const shrunk = areas.filter((area) => area.h >= 50 && boxHectares(area.b) < area.h * 0.8);
if (shrunk.length > areas.length / 200)
  throw new Error(
    `${shrunk.length} outlines smaller than their area, e.g. ${shrunk
      .slice(0, 5)
      .map((area) => area.n)
      .join(', ')}`,
  );
const snapshot = {
  source: 'Naturvårdsverket',
  built: new Date().toISOString().slice(0, 10),
  areas,
};
await mkdir(path.dirname(OUT), { recursive: true });
const text = JSON.stringify(snapshot);
await writeFile(OUT, text);
console.log(
  `${counts.np} national parks, ${counts.nr} nature reserves, ${counts.kr} culture reserves; ${(text.length / 1e6).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`,
);
