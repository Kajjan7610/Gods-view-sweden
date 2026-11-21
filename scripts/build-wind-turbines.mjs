#!/usr/bin/env node
/**
 * Build the wind turbine snapshot read by /api/wind-turbines:
 *
 *   src/data/local_data/se_wind_turbines/wind-turbines.json
 *
 * Länsstyrelserna's Vindbrukskollen, the county boards' register of wind
 * turbines (CC0 1.0, "Ange Länsstyrelsen som källa"; metadata
 * ed5814b2-08bf-493a-a164-7819e1b590d6 in Länsstyrelsernas
 * geodatakatalog), as the zipped shapefile its ATOM feed
 * (ATOM_lst.vbk_vindkraftverk.xml) points to, in SWEREF 99 TM. Some 24 000
 * rows: built, granted, in process, appealed, refused, withdrawn and
 * dismantled turbines. Only the data is used: Energimyndigheten's background
 * maps for the register may be used only in the permit process.
 *
 * What a turbine keeps, and what never is (the organisation number, the
 * siting, the kind of permit case, the permit's time limit), is in
 * src/layers/windTurbines/records.js: the operator's name only when it is
 * plainly a company's, and no project name that reads as a person's name or
 * holds a metering-point id or a property designation. A turbine listed
 * twice keeps its latest row, compared before places are looked at; turbines
 * with no place at all (the register's 0, 0, all of them planned or closed
 * cases) are left out. The rows are packed as arrays with one shared string
 * table (records.js, packTurbines).
 *
 * The snapshot carries the date the county boards made the export (their
 * ReadMe's "Filen skapad datum") as `exported`, the build date as `built`
 * and the latest update in the register as `updated`.
 *
 * Run it by hand now and then, never from the app. The zip is downloaded
 * once into .gev-cache/vindbrukskollen/ (or --cache), or read from --from.
 *
 * Usage:
 *   node scripts/build-wind-turbines.mjs [--from <lst.vbk_vindkraftverk.zip>]
 *     [--cache <folder>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDbf, readShpPoints, zipEntries } from './lib/shapefile.mjs';
import {
  TURBINE_STATUSES,
  normalizeTurbines,
  operatorName,
  packTurbines,
  projectName,
  statusIndex,
} from '../src/layers/windTurbines/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/data/local_data/se_wind_turbines');
const OUT = path.join(OUT_DIR, 'wind-turbines.json');
const FILE = 'lst.vbk_vindkraftverk.zip';
const URL_ZIP = `https://ext-dokument.lansstyrelsen.se/gemensamt/geodata/ShapeExport/${FILE}`;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}
const CACHE = path.resolve(
  argument('--cache') ?? path.join(ROOT, '.gev-cache', 'vindbrukskollen'),
);

/** The zip: from the given path, the cache, or the county boards. */
async function zipBytes() {
  const from = argument('--from');
  if (from) return new Uint8Array(await readFile(path.resolve(from)));
  const cached = path.join(CACHE, FILE);
  if (!existsSync(cached)) {
    console.log(`Downloading ${URL_ZIP}`);
    const response = await fetch(URL_ZIP, {
      headers: {
        'User-Agent':
          'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)',
      },
    });
    if (!response.ok) throw new Error(`${FILE}: HTTP ${response.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(cached, Buffer.from(await response.arrayBuffer()));
  }
  return new Uint8Array(await readFile(cached));
}

const entries = zipEntries(await zipBytes(), [
  '.shp',
  '.dbf',
  '.prj',
  '.cpg',
  'readme.html',
]);
const part = (suffix) =>
  [...entries].find(([name]) => name.toLowerCase().endsWith(suffix))?.[1] ??
  null;
const decode = (bytes) => new TextDecoder().decode(bytes ?? new Uint8Array());
if (!/SWEREF99_TM/.test(decode(part('.prj'))))
  throw new Error(`${FILE}: not SWEREF 99 TM`);
const cpg = decode(part('.cpg')).trim();
const records = readDbf(
  part('.dbf'),
  /1252|8859/.test(cpg) ? 'windows-1252' : 'utf-8',
);
const points = readShpPoints(part('.shp'));
if (records.length !== points.length)
  throw new Error(`${records.length} records, ${points.length} points`);
const exportedMatch = /Filen skapad datum:\s*(\d{4})(\d{2})(\d{2})/.exec(
  decode(part('readme.html')).replace(/<[^>]+>/g, ' '),
);
const exported = exportedMatch
  ? `${exportedMatch[1]}-${exportedMatch[2]}-${exportedMatch[3]}`
  : null;

const unknownStatuses = [
  ...new Set(
    records.filter((r) => r && statusIndex(r.STATUS) < 0).map((r) => r.STATUS),
  ),
];
const rows = normalizeTurbines(records, points);
if (rows.length < 10_000) throw new Error(`Too few turbines: ${rows.length}`);
rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const tally = (list, key) =>
  Object.entries(
    list.reduce(
      (sums, row) => ({ ...sums, [row[key]]: (sums[row[key]] ?? 0) + 1 }),
      {},
    ),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} ${count}`)
    .join(', ');

const present = records.filter(Boolean);
const withOperator = present.filter((r) => String(r.ORGNAMN ?? '').trim());
const operatorsKept = withOperator.filter((r) =>
  operatorName(r.ORGNAMN, r.ORGNMR),
);
const operatorsDropped = withOperator.filter(
  (r) => !operatorName(r.ORGNAMN, r.ORGNMR),
);
const operatorNames = (list) =>
  new Set(list.map((r) => String(r.ORGNAMN).trim())).size;
const unnamed = rows.filter((row) => !row.project).length;
const droppedProjects = new Set(
  present
    .map((r) => String(r.PROJNAMN ?? '').trim())
    .filter((name) => name && !projectName(name)),
);
const ids = new Set(present.map((r) => r.VERKID));
const updated = rows
  .map((row) => row.updated)
  .filter(Boolean)
  .sort()
  .at(-1);
const built = new Date().toISOString().slice(0, 10);

const json = JSON.stringify({
  source: 'Länsstyrelserna, Vindbrukskollen',
  licence: 'CC0 1.0',
  exported,
  built,
  updated: updated ?? null,
  ...packTurbines(rows),
});
await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, json);

const byStatus = rows.map((row) => ({
  status: TURBINE_STATUSES[row.status].status,
  kind: row.kind,
}));
console.log(
  `${present.length} register rows, ${ids.size} turbine ids → ${rows.length} turbines with a place ` +
    `(exported ${exported ?? 'unknown'}, latest update ${updated ?? 'unknown'})\n` +
    `  by status: ${tally(byStatus, 'status')}\n` +
    `  by kind: ${tally(byStatus, 'kind')}\n` +
    `  register rows by status: ${tally(present, 'STATUS')}\n` +
    (unknownStatuses.length
      ? `  UNKNOWN statuses, drawn as "no status": ${unknownStatuses.join(', ')}\n`
      : '') +
    `  operator names: kept on ${operatorsKept.length} rows (${operatorNames(operatorsKept)} names), ` +
    `dropped on ${operatorsDropped.length} rows (${operatorNames(operatorsDropped)} names)\n` +
    `  project names left out (person, long number, property): ${droppedProjects.size} names; ` +
    `turbines without a project name: ${unnamed}\n` +
    `${(json.length / 1e6).toFixed(2)} MB → ${path.relative(ROOT, OUT)}`,
);
