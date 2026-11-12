#!/usr/bin/env node
/**
 * Build the 2026 Riksdag election snapshot read by /api/election-districts:
 *
 *   src/data/local_data/se_election_districts/riksdag-2026.json
 *
 * Valmyndigheten's open data (free to use with Valmyndigheten credited,
 * val.se/valresultat-och-statistik/statistik-och-data/om-var-oppna-data):
 * the district maps for the whole country ("Valdistrikt i val 2026 –
 * kartor", drawn by the county boards, GeoJSON in SWEREF 99 TM) and the
 * final votes per district ("Röster per distrikt i riksdagsvalet 2026,
 * slutlig rösträkning"). Each ring is turned into WGS 84, simplified
 * (Douglas–Peucker, from 5 m for a district in town to 40 m for a large
 * rural one) and delta-encoded like the municipality snapshot.
 * Every district is checked against the municipality it belongs to.
 *
 * Run it by hand when Valmyndigheten corrects a file, never from the app.
 * The two files are downloaded once into .gev-cache/election-districts/,
 * or given as local paths.
 *
 * Usage:
 *   node scripts/build-election-districts.mjs [--maps <zip>] [--votes <xlsx>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readZipText,
  sharedStrings,
  sheetPaths,
  sheetRows,
} from '../server/providers/cityDossierElection.js';
import {
  ELECTION_YEAR,
  districtResults,
  encodeLine,
  polygonsBounds,
  sweref99tmToWgs84,
} from '../src/layers/electionDistricts/records.js';
import {
  areaAt,
  decodeLine,
  indexAreas,
  simplifyLine,
} from '../src/layers/municipalities/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(
  ROOT,
  'src/data/local_data/se_election_districts/riksdag-2026.json',
);
const CACHE = path.join(ROOT, '.gev-cache', 'election-districts');
const MAPS_URL =
  'https://www.val.se/download/18.332cf48819bd61ac1513889/1785491689960/valdistrikt-riket-2026.zip';
const VOTES_URL =
  'https://www.val.se/download/18.7faaad3f1a0b0c300e458a/1790069872234/roster-per-distrikt-slutligt-antal-roster-inklusive-totalt-valdeltagande-riksdagsvalet-2026.xlsx';
/** Simplify a district by a 150th of its size, within these bounds (m). */
const TOLERANCE_MIN_M = 5;
const TOLERANCE_MAX_M = 40;

/** The tolerance for a district from its extent in SWEREF 99 TM metres. */
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
const round5 = (value) => Math.round(value * 1e5) / 1e5;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

/** A local file, or Valmyndigheten's, downloaded once into the cache. */
async function source(localPath, url, cacheName) {
  if (localPath) return new Uint8Array(await readFile(localPath));
  const cached = path.join(CACHE, cacheName);
  if (existsSync(cached)) return new Uint8Array(await readFile(cached));
  console.log(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)',
    },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, bytes);
  return bytes;
}

const maps = await source(argument('--maps'), MAPS_URL, 'valdistrikt-riket-2026.zip');
const workbook = await source(argument('--votes'), VOTES_URL, 'riksdag-distrikt-2026.xlsx');

// The votes and turnout per district.
const base = readZipText(
  workbook,
  new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']),
);
const sheets = sheetPaths(
  base.get('xl/workbook.xml'),
  base.get('xl/_rels/workbook.xml.rels'),
);
const strings = sharedStrings(base.get('xl/sharedStrings.xml'));
const rows = (name) => {
  const part = sheets.get(name);
  if (!part) throw new Error(`workbook lacks the sheet ${name}`);
  return sheetRows(readZipText(workbook, new Set([part])).get(part), strings);
};
const results = districtResults(
  rows('Antal_distrikt'),
  rows('Valdeltagande_distrikt'),
);

// The district maps.
const entries = readZipText(maps, new Set(['valdistrikt-riket-2026.geojson']));
const geojson = JSON.parse(entries.get('valdistrikt-riket-2026.geojson') ?? 'null');
if (!/3006/.test(JSON.stringify(geojson?.crs ?? '')))
  throw new Error('Expected the district maps in SWEREF 99 TM (EPSG:3006)');

// The municipalities, to check each district lies in its own.
const municipalities = JSON.parse(
  await readFile(
    path.join(ROOT, 'src/data/local_data/se_municipalities/municipalities.json'),
    'utf8',
  ),
);
const municipalityIndex = indexAreas(
  municipalities.municipalities,
  municipalities.lines.map((line) => decodeLine(line.p)),
);

const districts = [];
let misplaced = 0;
let withoutVotes = 0;
for (const feature of geojson.features) {
  const props = feature.properties ?? {};
  const code = String(props.Valdistriktskod ?? '');
  if (!/^\d{8}$/.test(code)) continue;
  const geometry = feature.geometry;
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const tolerance = toleranceFor(polygons);
  const decoded = polygons
    .map((rings) =>
      rings
        .map((ring) =>
          simplifyLine(ring.map((point) => sweref99tmToWgs84(point)), tolerance),
        )
        .filter((ring) => ring.length >= 4),
    )
    // A polygon whose outer ring collapsed is gone, holes and all.
    .filter((rings) => rings.length && rings[0].length >= 4);
  if (!decoded.length) continue;
  const result = results.get(code);
  if (!result) withoutVotes++;
  const bounds = polygonsBounds(decoded);
  const centre = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const municipality = areaAt(municipalityIndex, centre);
  if (municipality && municipality.code !== String(props.Kommunkod)) misplaced++;
  districts.push({
    c: code,
    n: String(props.Valdistriktsnamn ?? code).slice(0, 80),
    k: String(props.Kommunkod ?? ''),
    m: String(props.Kommun ?? '').slice(0, 60),
    b: bounds.map(round5),
    g: decoded.map((rings) => rings.map((ring) => encodeLine(ring))),
    ...(result
      ? { v: result.votes, s: result.shares, t: result.turnout }
      : {}),
  });
}

// A box centre can fall in the next municipality for a long, thin district;
// many doing so means the coordinates are wrong.
if (districts.length < 6000)
  throw new Error(`Expected about 6 300 districts, got ${districts.length}`);
if (misplaced > districts.length * 0.05)
  throw new Error(`${misplaced} districts lie outside their municipality`);

const snapshot = {
  source: 'Valmyndigheten',
  election: `Riksdag ${ELECTION_YEAR}`,
  built: new Date().toISOString().slice(0, 10),
  districts,
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot));
const size = JSON.stringify(snapshot).length;
console.log(
  `${districts.length} districts, ${withoutVotes} without votes, ${misplaced} with their box centre in another municipality; ${(size / 1e6).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`,
);
