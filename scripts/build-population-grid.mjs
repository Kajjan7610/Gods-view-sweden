#!/usr/bin/env node
/**
 * Build the population grid snapshot read by /api/population-grid:
 *
 *   server/data/se_population_grid/population-2025.json
 *
 * (outside the folders the dev server serves: only the server reads it).
 *
 * SCB's population per 1 km square ("Befolkning per kvadratkilometer",
 * stat:befolkning_1km_2025 on SCB's open geodata WFS, CC0, reference date
 * 2025-12-31), SWEREF 99 TM. Only the total per square is asked for, never
 * the ages or the sexes. Squares nobody lives in are not in SCB's data, and
 * SCB protects small counts itself (random noise on them). The 5, 10 and
 * 25 km sums are worked out here from the exact 1 km counts, so they are
 * processed SCB data ("bearbetning av SCB-data"), not SCB's own figures.
 * Then each 1 km square is kept as its colour class alone (`densityClass`,
 * what the route sends): the file never holds an exact 1 km count. Each
 * square is its south-west corner and its value, packed as integers: no
 * geometry, the layer draws the squares from their corners.
 *
 * Each level is packed as `[step, value, step, value, …]`, the value a
 * 1 km square's class or a summed square's people: a square's
 * place is its row (north) times the level's width plus its column (east),
 * counted in squares from the level's origin, and `step` is how far it is
 * from the square before it in that order.
 *
 * Run it by hand once a year, never from the app. The CSV pages are
 * downloaded once into .gev-cache/population-grid/, or read from a folder.
 *
 * Usage:
 *   node scripts/build-population-grid.mjs [--from <folder with page-*.csv>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRID_LEVELS_KM,
  GRID_YEAR,
  DENSITY_CLASSES,
  decodeLevel,
  densityClass,
} from '../src/layers/populationGrid/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(
  ROOT,
  `server/data/se_population_grid/population-${GRID_YEAR}.json`,
);
const CACHE = path.join(ROOT, '.gev-cache', 'population-grid');
const WFS = 'https://geodata.scb.se/geoserver/stat/wfs';
const TYPE_NAME = `stat:befolkning_1km_${GRID_YEAR}`;
const REFERENCE_DATE = `${GRID_YEAR}1231`;
/** Rows per WFS page; the pages are read in objectid order. */
const PAGE = 50_000;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

/** One CSV page: from the given folder, the cache, or SCB. */
async function page(index) {
  const file = `page-${GRID_YEAR}-${index}.csv`;
  const from = argument('--from');
  if (from) {
    const local = path.join(from, file);
    return existsSync(local) ? readFile(local, 'utf8') : '';
  }
  const cached = path.join(CACHE, file);
  if (existsSync(cached)) return readFile(cached, 'utf8');
  const url = new URL(WFS);
  for (const [key, value] of Object.entries({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: TYPE_NAME,
    outputFormat: 'csv',
    // The total alone: SCB's ages and sexes per square are never read.
    propertyName: 'rutid_scb,rutstorl,beftotalt,referenstid',
    sortBy: 'objectid',
    count: String(PAGE),
    startIndex: String(index * PAGE),
  }))
    url.searchParams.set(key, value);
  console.log(`Downloading ${TYPE_NAME} rows ${index * PAGE}…`);
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)',
    },
  });
  if (!response.ok) throw new Error(`${TYPE_NAME}: HTTP ${response.status}`);
  const text = await response.text();
  if (!text.startsWith('FID,'))
    throw new Error(`${TYPE_NAME}: not CSV: ${text.slice(0, 200)}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, text);
  return text;
}

/** The squares of every page, by SCB id: `[east m, north m, people]`. */
async function readSquares() {
  const squares = new Map();
  for (let index = 0; ; index += 1) {
    const lines = (await page(index)).split(/\r?\n/).filter(Boolean);
    if (!lines.length) break;
    const header = lines[0].split(',');
    const column = (name) => {
      const at = header.indexOf(name);
      if (at < 0) throw new Error(`No ${name} column in ${header.join()}`);
      return at;
    };
    const [id, size, total, date] = [
      'rutid_scb',
      'rutstorl',
      'beftotalt',
      'referenstid',
    ].map(column);
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      const rutid = cells[id];
      // SCB's id is the square's south-west corner: six digits east, seven
      // north, in metres (rutid_inspire "N6647000E590000" is 5900006647000).
      if (!/^\d{13}$/.test(rutid)) throw new Error(`Odd square id ${rutid}`);
      if (cells[size] !== '1000') throw new Error(`${rutid}: not 1 km`);
      if (cells[date] !== REFERENCE_DATE)
        throw new Error(`${rutid}: reference date ${cells[date]}`);
      const people = Number(cells[total]);
      if (!Number.isInteger(people))
        throw new Error(`${rutid}: ${cells[total]}`);
      if (people <= 0) continue;
      squares.set(rutid, [
        Number(rutid.slice(0, 6)),
        Number(rutid.slice(6)),
        people,
      ]);
    }
    if (lines.length - 1 < PAGE) break;
  }
  return [...squares.values()];
}

/**
 * Squares of `km` km summed from the exact 1 km ones, packed as the file
 * keeps them; the 1 km level keeps each square's class, not its people.
 */
function packLevel(squares, km) {
  const size = km * 1000;
  const sums = new Map();
  for (const [east, north, people] of squares) {
    const column = Math.floor(east / size);
    const row = Math.floor(north / size);
    const key = `${column}:${row}`;
    const sum = sums.get(key);
    if (sum) sum[2] += people;
    else sums.set(key, [column, row, people]);
  }
  const cells = [...sums.values()];
  let minColumn = Infinity;
  let maxColumn = -Infinity;
  let minRow = Infinity;
  for (const [column, row] of cells) {
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
    minRow = Math.min(minRow, row);
  }
  const width = maxColumn - minColumn + 1;
  const places = cells
    .map(([column, row, people]) => [
      (row - minRow) * width + (column - minColumn),
      km === 1 ? densityClass(people) : people,
    ])
    .sort((p, q) => p[0] - q[0]);
  const packed = [];
  let previous = 0;
  for (const [place, value] of places) {
    packed.push(place - previous, value);
    previous = place;
  }
  return {
    value: km === 1 ? 'class' : 'people',
    origin: [minColumn, minRow],
    width,
    cells: packed,
  };
}

const squares = await readSquares();
const population = squares.reduce((sum, [, , people]) => sum + people, 0);
if (
  squares.length < 100_000 ||
  population < 10_000_000 ||
  population > 11_500_000
)
  throw new Error(
    `Unlikely grid: ${squares.length} squares, ${population} people`,
  );
for (const [east, north] of squares)
  if (
    east < 200_000 ||
    east > 1_000_000 ||
    north < 6_100_000 ||
    north > 7_700_000
  )
    throw new Error(`Square outside Sweden: ${east} ${north}`);

const levels = Object.fromEntries(
  GRID_LEVELS_KM.map((km) => [km, packLevel(squares, km)]),
);
const snapshot = {
  source: 'SCB',
  year: GRID_YEAR,
  referenceDate: `${GRID_YEAR}-12-31`,
  built: new Date().toISOString().slice(0, 10),
  squares: squares.length,
  population,
  levels,
};
// Every summed level unpacks to the same people as the squares hold, and
// the 1 km level to one class per square, never a count.
for (const km of GRID_LEVELS_KM) {
  const { values } = decodeLevel(levels[km], km);
  if (km === 1) {
    if (values.length !== squares.length) throw new Error('1 km: squares lost');
    if (values.some((value) => value < 1 || value >= DENSITY_CLASSES.length))
      throw new Error('1 km: not a class');
    continue;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum !== population) throw new Error(`${km} km: ${sum} ≠ ${population}`);
}
await mkdir(path.dirname(OUT), { recursive: true });
const text = JSON.stringify(snapshot);
await writeFile(OUT, text);
console.log(
  `${squares.length} squares, ${population} people; ${GRID_LEVELS_KM.map(
    (km) => `${km} km: ${levels[km].cells.length / 2}`,
  ).join(
    ', ',
  )}; ${(text.length / 1e6).toFixed(2)} MB → ${path.relative(ROOT, OUT)}`,
);
