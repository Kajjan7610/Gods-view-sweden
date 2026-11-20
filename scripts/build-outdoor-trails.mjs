#!/usr/bin/env node
/**
 * Build the trails and outdoor facilities snapshots read by
 * /api/outdoor-trails:
 *
 *   src/data/local_data/se_outdoor_trails/facilities.json
 *   src/data/local_data/se_outdoor_trails/trails.json
 *
 * Naturvårdsverket's "Leder och friluftsanordningar" as open data (CC0;
 * Naturvårdsverket welcomes a reference, "Källa: Naturvårdsverket"), as
 * GeoJSON in SWEREF 99 TM that appears to be rebuilt nightly (the files are
 * dated 03:30 each day): Anordningar.geojson (some 21 700
 * facilities) and Leder.geojson (some 12 000 trail segments). The state
 * mountain trails are in Leder.geojson too, with their names, so
 * Statliga_Leder.geojson is not needed.
 *
 * Facilities: the type "Bostad" (a residence) is left out; kept per facility
 * are its id, place, name, type and subtype, legend class, whether it is
 * adapted for reduced mobility, its description cut to 180 characters, its
 * protected area and whether it is on a state trail. Trails: a trail's
 * segments are put together by its id, joined where they meet, turned into
 * WGS 84, simplified (Douglas–Peucker, SIMPLIFY_M) and delta-encoded like
 * the municipality snapshot, with its box; kept are its name, type, category,
 * legend class, marking, description, protected area, length and whether it
 * is a state trail. Geometry quality, OBJECTIDs and register ids stay out.
 *
 * Descriptions lose every sentence with an e-mail address, a phone number or
 * a named contact person (records.js, withoutContacts): a few managers wrote
 * an official's name, mobile number or e-mail for visitors on a sign.
 *
 * Run it by hand now and then, never from the app. The files are downloaded
 * once into .gev-cache/outdoor-trails/ (or --cache), or read from a folder.
 *
 * Usage:
 *   node scripts/build-outdoor-trails.mjs [--from <folder with
 *     Anordningar.geojson and Leder.geojson>] [--cache <folder>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeLine,
  joinLines,
  linesBounds,
  normalizeFacilities,
  normalizeTrails,
  packFacility,
  packTrail,
  withoutContacts,
} from '../src/layers/outdoorTrails/records.js';
import { simplifyLine } from '../src/layers/municipalities/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/data/local_data/se_outdoor_trails');
const FACILITIES_OUT = path.join(OUT_DIR, 'facilities.json');
const TRAILS_OUT = path.join(OUT_DIR, 'trails.json');
const BASE = 'https://geodata.naturvardsverket.se/nedladdning/friluftsliv/';
const FILES = Object.freeze({
  facilities: 'Anordningar.geojson',
  trails: 'Leder.geojson',
});
/** Douglas–Peucker tolerance for the trails (m); positions are ±20 m. */
const SIMPLIFY_M = 6;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}
const CACHE = path.resolve(
  argument('--cache') ?? path.join(ROOT, '.gev-cache', 'outdoor-trails'),
);

/** A file's features: from the given folder, the cache, or Naturvårdsverket. */
async function featuresOf(file) {
  const from = argument('--from');
  let raw;
  if (from) raw = await readFile(path.join(from, file), 'utf8');
  else {
    const cached = path.join(CACHE, file);
    if (!existsSync(cached)) {
      console.log(`Downloading ${BASE}${file}`);
      const response = await fetch(`${BASE}${file}`, {
        headers: {
          'User-Agent':
            'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)',
        },
      });
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      await mkdir(CACHE, { recursive: true });
      await writeFile(cached, Buffer.from(await response.arrayBuffer()));
    }
    raw = await readFile(cached, 'utf8');
  }
  const parsed = JSON.parse(raw);
  const crs = parsed?.crs?.properties?.name ?? '';
  if (!/3006/.test(crs)) throw new Error(`${file}: not SWEREF 99 TM (${crs})`);
  if (!Array.isArray(parsed.features)) throw new Error(`${file}: no features`);
  return parsed.features;
}

const tally = (rows, key) =>
  Object.entries(
    rows.reduce(
      (sums, row) => ({ ...sums, [row[key]]: (sums[row[key]] ?? 0) + 1 }),
      {},
    ),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} ${count}`)
    .join(', ');

// Facilities.
const facilityFeatures = await featuresOf(FILES.facilities);
const residences = facilityFeatures.filter((f) =>
  /bostad/i.test(`${f.properties?.TYP ?? ''} ${f.properties?.UNDERTYP ?? ''}`),
).length;
const facilities = normalizeFacilities(facilityFeatures);

/** The features whose description lost a sentence with contact details. */
const scrubbed = (features) =>
  features.filter((f) => {
    const raw = f.properties?.BESKRIVNING;
    const clean = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean && withoutContacts(raw) !== clean;
  });
const scrubbedFacilities = scrubbed(facilityFeatures).map(
  (f) => f.properties.ANORDNING_ID,
);

// Trails: segments by id, joined, simplified, encoded.
const segments = await featuresOf(FILES.trails);
const scrubbedTrails = [
  ...new Set(scrubbed(segments).map((f) => f.properties.LED_ID)),
];
let pointsIn = 0;
let pointsOut = 0;
let linesOut = 0;
const trails = [];
for (const row of normalizeTrails(segments)) {
  for (const line of row.lines) pointsIn += line.length;
  const lines = joinLines(row.lines)
    .map((line) => simplifyLine(line, SIMPLIFY_M))
    .filter((line) => line.length >= 2);
  if (!lines.length) continue;
  for (const line of lines) pointsOut += line.length;
  linesOut += lines.length;
  trails.push(packTrail(row, lines.map(encodeLine), linesBounds(lines)));
}

if (facilities.length < 15_000 || trails.length < 3000)
  throw new Error(
    `Too few rows: ${facilities.length} facilities, ${trails.length} trails`,
  );

const built = new Date().toISOString().slice(0, 10);
await mkdir(OUT_DIR, { recursive: true });
const sizes = [];
for (const [file, key, list] of [
  [FACILITIES_OUT, 'facilities', facilities.map(packFacility)],
  [TRAILS_OUT, 'trails', trails],
]) {
  const json = JSON.stringify({
    source: 'Naturvårdsverket',
    built,
    [key]: list,
  });
  await writeFile(file, json);
  sizes.push(
    `${(json.length / 1e6).toFixed(2)} MB → ${path.relative(ROOT, file)}`,
  );
}
const others = facilities.filter((row) => row.kind === 'other');
console.log(
  `${facilities.length} facilities (${residences} residences left out): ${tally(facilities, 'kind')}\n` +
    `  "other": ${tally(others, 'type')}\n` +
    `${trails.length} trails from ${segments.length} segments, ${trails.filter((row) => row.s).length} state trails: ${tally(trails, 'k')}\n` +
    `  ${pointsIn} points → ${pointsOut} in ${linesOut} lines\n` +
    `Contact details taken out of ${scrubbedFacilities.length} facility descriptions (${scrubbedFacilities.join(', ')}) and ${scrubbedTrails.length} trails' (${scrubbedTrails.join(', ')})\n` +
    sizes.join('\n'),
);
