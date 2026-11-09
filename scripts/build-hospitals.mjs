#!/usr/bin/env node
/**
 * Build the Swedish hospital snapshot read by /api/hospitals:
 *
 *   src/data/local_data/se_hospitals/hospitals.json
 *
 * Hospitals come from OpenStreetMap through one Overpass query
 * (`amenity=hospital` or `healthcare=hospital`, a box around Sweden), kept
 * when their name reads as a hospital (src/layers/hospitals/records.js) and
 * they lie in Sweden by the bundled Natural Earth boundary. The emergency
 * departments in Socialstyrelsen's fact sheet (akut-2025.json beside the
 * snapshot, from the appendix of art.nr 2026-6-10339) are joined to their
 * hospitals by the hand-kept DEPARTMENT_SITES below; a department the sheet
 * reports for several hospitals together (Sahlgrenska, Hallands sjukhus, …)
 * gives its figures to each of its sites, marked as shared. Each hospital
 * gets its ground height above the ellipsoid from Re:Earth Terrain
 * (Mapterhorn, CC BY 4.0). The snapshot is OSM data, so it is licensed ODbL
 * and says so.
 *
 * Run it by hand when OSM or a new fact sheet changes, never from the app.
 *
 * Usage:
 *   node scripts/build-hospitals.mjs [--endpoint <overpass-url>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BOX,
  ROOT,
  countries,
  countryOf,
  createCache,
} from './lib/osmSnapshot.mjs';
import {
  dedupeHospitals,
  isHospitalName,
  normalizeHospital,
} from '../src/layers/hospitals/records.js';

const DIR = path.join(ROOT, 'src/data/local_data/se_hospitals');
const OUT = path.join(DIR, 'hospitals.json');
const STATS = path.join(DIR, 'akut-2025.json');

/**
 * Socialstyrelsen's department name → the OSM hospitals it covers. Several
 * sites share one department's figures where the sheet reports them together.
 */
const DEPARTMENT_SITES = {
  Blekingesjukhuset: ['w143104485'],
  'Falu lasarett': ['w142528033'],
  'Mora lasarett': ['w162063827'],
  'Visby lasarett': ['r1722775'],
  'Länssjukhuset Gävle-Sandviken': ['n11805593530'],
  'Hudiksvalls sjukhus': ['w136207757'],
  'Bollnäs närsjukhus': ['w392790200'],
  'Hallands sjukhus': ['r10460973', 'r10950273'],
  'Östersunds sjukhus': ['w39773881'],
  Höglandssjukhuset: ['w255675984'],
  'Länssjukhuset Ryhov': ['w914187015'],
  'Värnamo sjukhus': ['r11587856'],
  'Länssjukhuset i Kalmar': ['w148061439'],
  'Oskarshamns sjukhus': ['r14678665'],
  'Västerviks sjukhus': ['w312683614'],
  'Ljungby lasarett': ['r6359614'],
  'Centrallasarettet i Växjö': ['r13413186'],
  'Gällivare sjukhus': ['r16173391'],
  'Kalix sjukhus': ['w103818571'],
  'Kiruna sjukhus': ['r2129957'],
  'Piteå Älvdals sjukhus': ['r21783965'],
  'Sunderby sjukhus': ['w230709556'],
  'Helsingborgs lasarett': ['w89744244'],
  'Centralsjukhuset i Kristianstad': ['w203226671'],
  'Skånes universitetssjukhus Lund': ['r909092'],
  'Skånes universitetssjukhus Malmö': ['w28807180'],
  'Lasarettet i Ystad': ['w80956157'],
  'Ängelholms sjukhus': ['r8382766'],
  'Capio Sankt Görans sjukhus': ['w66342599'],
  'Danderyds sjukhus': ['w745152371'],
  'Karolinska universitetssjukhuset Huddinge': ['w392785310'],
  'Nya Karolinska Solna': ['w126241903'],
  'Norrtälje sjukhus': ['w745153976'],
  Södersjukhuset: ['w153260921'],
  'Södertälje sjukhus': ['w331006879'],
  Mälarsjukhuset: ['w219869005'],
  'Kullbergska sjukhuset': ['r10099452'],
  'Nyköpings lasarett': ['w170863669'],
  'Lasarettet i Enköping': ['w380155787'],
  'Akademiska sjukhuset': ['w184649365'],
  'Sjukhuset i Arvika': ['w393456227'],
  'Centralsjukhuset i Karlstad': ['w232336422'],
  'Sjukhuset i Torsby': ['w158324369'],
  'Lycksele lasarett': ['w302950635'],
  'Skellefteå lasarett': ['w91876692'],
  'Norrlands Universitetssjukhus': ['w202665362'],
  'Sollefteå sjukhus': ['w330603825'],
  'Länssjukhuset i Sundsvall-Härnösand': ['w190922279'],
  'Örnsköldsviks sjukhus': ['w37097656'],
  'Västmanlands sjukhus Köping': ['w972843967'],
  'Västmanlands sjukhus Västerås': ['w392774319'],
  'Södra Älvsborgs sjukhus': ['r1734405'],
  'Sahlgrenska universitetssjukhuset': ['r18627335', 'r10757570', 'r12707317'],
  'Skaraborgs sjukhus': ['w1362430855', 'r280131'],
  'Norra Älvsborgs Länssjukhus och Uddevalla sjukhus': ['w394646100'],
  'Sjukhusen i väster': ['w585734883'],
  'Universitetssjukhuset Örebro': ['w360413263'],
  'Karlskoga lasarett': ['w395221047'],
  'Lindesbergs lasarett': ['r18022442'],
  'Universitetssjukhuset i Linköping': ['w42877273'],
  'Lasarettet i Motala': ['w162837811'],
  'Vrinnevisjukhuset i Norrköping': ['r20618484'],
};
/** Names for sites mapped only as a hospital building, without a name. */
const SITE_NAMES = { r18022442: 'Lindesbergs lasarett' };

const stats = JSON.parse(await readFile(STATS, 'utf8'));
const departments = new Map(stats.departments.map((row) => [row.name, row]));
for (const name of departments.keys())
  if (!DEPARTMENT_SITES[name]) throw new Error(`No site for ${name}`);
const siteOf = new Map();
for (const [name, ids] of Object.entries(DEPARTMENT_SITES)) {
  if (!departments.has(name)) throw new Error(`Not in the sheet: ${name}`);
  for (const id of ids) siteOf.set(id, name);
}

const cache = createCache('gev-hospitals');
const byIdQuery = (type, ids) =>
  ids.length ? `${type}(id:${ids.join(',')});` : '';
const extra = Object.keys(SITE_NAMES);
const ofType = (letter) =>
  extra.filter((id) => id[0] === letter).map((id) => id.slice(1));
const result = await cache.overpass(
  `[out:json][timeout:180][bbox:${BOX}];(nwr["amenity"="hospital"];nwr["healthcare"="hospital"];` +
    `${byIdQuery('node', ofType('n'))}${byIdQuery('way', ofType('w'))}${byIdQuery('rel', ofType('r'))});out tags center;`,
);
const osmBase = result.osm3s?.timestamp_osm_base ?? null;
const byIso = await countries();

const candidates = [];
for (const element of result.elements) {
  const id = `${element.type[0]}${element.id}`;
  const row = normalizeHospital(element, SITE_NAMES[id] ?? null);
  if (!row) continue;
  if (!siteOf.has(id) && !isHospitalName(row.name)) continue;
  if (countryOf(byIso, row.point) !== 'SWE') continue;
  candidates.push(row);
}
const hospitals = dedupeHospitals(candidates, new Set(siteOf.keys()));

const missing = [...siteOf.keys()].filter(
  (id) => !hospitals.some((row) => row.id === id),
);
if (missing.length) throw new Error(`Sites not in OSM: ${missing.join(', ')}`);

const shared = new Map();
for (const name of siteOf.values()) shared.set(name, (shared.get(name) || 0) + 1);
for (const row of hospitals) {
  const name = siteOf.get(row.id);
  if (!name) continue;
  const { name: department, ...figures } = departments.get(name);
  row.ed = { department, ...figures, ...(shared.get(name) > 1 ? { shared: true } : {}) };
}

await cache.groundHeights(hospitals);
hospitals.sort((a, b) => a.name.localeCompare(b.name, 'sv'));

const snapshot = {
  schemaVersion: 1,
  source: 'OpenStreetMap contributors',
  license: 'ODbL-1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  osmBase,
  statistics: {
    source: stats.source,
    publication: stats.publication,
    articleNumber: stats.articleNumber,
    published: stats.published,
    url: stats.url,
    year: stats.year,
    national: stats.national,
  },
  heightSource:
    'Re:Earth Terrain (Mapterhorn, CC BY 4.0), metres above WGS84',
  builtAt: new Date().toISOString(),
  hospitals,
};
await writeFile(OUT, `${JSON.stringify(snapshot)}\n`);
const withEd = hospitals.filter((row) => row.ed).length;
console.log(
  `${hospitals.length} hospitals, ${withEd} with emergency statistics (OSM ${osmBase}) → ${path.relative(ROOT, OUT)}`,
);
