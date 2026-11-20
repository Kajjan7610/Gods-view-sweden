#!/usr/bin/env node
/**
 * Build the protected-nature snapshots read by /api/protected-nature:
 *
 *   src/data/local_data/se_protected_nature/protected-nature.json
 *   src/data/local_data/se_protected_nature/natura2000.json
 *   src/data/local_data/se_protected_nature/access-bans.json
 *
 * Naturvårdsverket's Naturvårdsregistret as open data (CC0, "Källa:
 * Naturvårdsverket" asked for; "Naturvårdsregistret – beskrivning av öppna
 * data", edition 1.2): the national parks (NP), the nature reserves in force
 * (NR) and the culture reserves (KR), the Natura 2000 areas (the Birds
 * Directive's SPA and the Habitats Directive's SCI, a site in both files
 * kept once) and the access bans (tillträdesförbud) in force in protected
 * areas, most of them for bird and seal protection, shapefiles in SWEREF 99 TM. Water protection areas
 * and the other forms are left out on purpose: they would map the
 * drinking-water intakes, or add thousands of tiny areas. Each ring is
 * turned into WGS 84, simplified (Douglas–Peucker, by a 150th of the area's
 * size within bounds per file) and delta-encoded like the municipality
 * snapshot.
 *
 * Kept per area: its name, kind, size, municipality (a ban: its county) and
 * year, a ban's reason (birds, seals) and period. Never kept: the species,
 * habitats and descriptions (ARTER, NATURTYPER, KARAKTAR, KVALITET,
 * BESKRIVN). Beside a small ban zone they would point at a rare breeding
 * site. For the same reason a small ban for another reason than birds or
 * seals ("Övrigt", under 5 ha: a cliff, most likely a raptor's nest) is left
 * out whole.
 *
 * Natura 2000 has its own file, simplified harder: the SCI file alone holds
 * 8 million points (the river systems of Norrbotten and Västerbotten are most
 * of them), and the app reads it only for a close view.
 *
 * Run it by hand now and then, never from the app. The zips are downloaded
 * once into .gev-cache/protected-nature/, or read from a folder.
 *
 * Usage:
 *   node scripts/build-protected-nature.mjs [--from <folder with NP.zip, NR.zip,
 *     KR.zip, SPA_Rikstackande.zip, SCI_Rikstackande.zip, TILLTRADESFORBUD.zip>]
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
import {
  BAN_REASONS,
  banPeriod,
  naturaDesignation,
  naturaYear,
} from '../src/layers/protectedNature/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/data/local_data/se_protected_nature');
const OUT = path.join(OUT_DIR, 'protected-nature.json');
const NATURA_OUT = path.join(OUT_DIR, 'natura2000.json');
const BANS_OUT = path.join(OUT_DIR, 'access-bans.json');
const CACHE = path.join(ROOT, '.gev-cache', 'protected-nature');
const BASE =
  'https://geodata.naturvardsverket.se/nedladdning/naturvardsregistret/';
/** The forms kept, by file, with the kind the layer knows them by. */
const FORMS = Object.freeze([
  ['NP', 'np'],
  ['NR', 'nr'],
  ['KR', 'kr'],
]);
/** Natura 2000: the Birds Directive's sites, then the Habitats Directive's. */
const NATURA_FILES = Object.freeze([
  ['SPA_Rikstackande', 'spa'],
  ['SCI_Rikstackande', 'sci'],
]);
const BANS_FILE = 'TILLTRADESFORBUD';
/** An "Övrigt" ban zone smaller than this (ha) is left out: see above. */
const OTHER_BAN_MIN_HA = 5;
/**
 * Simplification bounds (m) per file: Natura 2000 harder, a ban zone finer.
 * A Natura 2000 area is also held to a number of points, coarser if need be:
 * the Torne and Kalix river system alone would keep some 68 000 at 120 m.
 */
const TOLERANCE = Object.freeze({
  forms: { min: 5, max: 50 },
  natura: { min: 15, max: 120, points: 8000 },
  bans: { min: 1, max: 25 },
});
const round5 = (value) => Math.round(value * 1e5) / 1e5;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

/** A form's zip: from the given folder, the cache, or Naturvårdsverket. */
async function zipFor(file) {
  const from = argument('--from');
  if (from)
    return new Uint8Array(await readFile(path.join(from, `${file}.zip`)));
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

/**
 * Each shapefile in a zip as its records beside its shapes. The SCI zip
 * holds three: the two northern river systems apart from the rest.
 */
async function shapefiles(file) {
  const entries = zipEntries(await zipFor(file), [
    '.shp',
    '.dbf',
    '.prj',
    '.cpg',
  ]);
  const sets = new Map();
  for (const [name, bytes] of entries) {
    const stem = name.replace(/\.[^./]+$/, '');
    const parts = sets.get(stem) ?? {};
    parts[name.slice(stem.length + 1).toLowerCase()] = bytes;
    sets.set(stem, parts);
  }
  return [...sets].map(([stem, parts]) => {
    const prj = new TextDecoder().decode(parts.prj ?? new Uint8Array());
    if (!/SWEREF99_TM/.test(prj)) throw new Error(`${stem}: not SWEREF 99 TM`);
    const cpg = new TextDecoder().decode(parts.cpg ?? new Uint8Array()).trim();
    // "1252" and "ISO 88591": Latin-1 is Windows-1252's subset.
    const records = readDbf(
      parts.dbf,
      /1252|8859/.test(cpg) ? 'windows-1252' : 'utf-8',
    );
    const shapes = readShpPolygons(parts.shp);
    if (records.length !== shapes.length)
      throw new Error(
        `${stem}: ${records.length} records, ${shapes.length} shapes`,
      );
    return { records, shapes };
  });
}

/** Simplify an area by a 150th of its size, within the bounds (m). */
function toleranceFor(polygons, { min, max }) {
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
  return Math.min(max, Math.max(min, size / 150));
}

/**
 * A shape's polygons in WGS 84, simplified; a tiny area simplified away is
 * tried again at a metre, one over its points again half as fine. Empty when
 * nothing is left.
 */
function outline(shape, bounds) {
  const wgs84 = shape.map((rings) =>
    rings.map((ring) => ring.map((point) => sweref99tmToWgs84(point))),
  );
  const simplified = (tolerance) =>
    wgs84
      .map((rings) =>
        rings
          .map((ring) => simplifyLine(ring, tolerance))
          .filter((ring) => ring.length >= 4),
      )
      .filter((rings) => rings.length && rings[0].length >= 4);
  const points = (polygons) =>
    polygons.reduce(
      (sum, rings) => rings.reduce((n, ring) => n + ring.length, sum),
      0,
    );
  let tolerance = toleranceFor(shape, bounds);
  let polygons = simplified(tolerance);
  if (!polygons.length && tolerance > 1) polygons = simplified(1);
  while (bounds.points && points(polygons) > bounds.points) {
    tolerance *= 2;
    polygons = simplified(tolerance);
  }
  return polygons;
}

const geometry = (decoded) => ({
  b: polygonsBounds(decoded).map(round5),
  g: decoded.map((rings) => rings.map((ring) => encodeLine(ring))),
});
const hectares = (value) => {
  const number = Number(value);
  if (value === '' || value === null || !Number.isFinite(number)) return {};
  // A ban zone is often a single skerry: a tenth of a hectare tells it.
  return { h: number < 10 ? Math.round(number * 10) / 10 : Math.round(number) };
};
const text = (value) => String(value ?? '').slice(0, 100);

const areas = [];
const counts = {};
for (const [file, kind] of FORMS) {
  counts[kind] = 0;
  for (const { records, shapes } of await shapefiles(file))
    records.forEach((record, index) => {
      const shape = shapes[index];
      // Only areas in force: a decision not yet final, or appealed, may change.
      if (!record || !shape || record.BESLSTATUS !== 'Gällande') return;
      const decoded = outline(shape, TOLERANCE.forms);
      if (!decoded.length) return;
      const year = Number(String(record.URSGALLDAT ?? '').slice(0, 4));
      areas.push({
        i: String(record.NVRID),
        n: text(record.NAMN),
        t: kind,
        ...(year > 1900 ? { y: year } : {}),
        k: text(record.KOMMUN),
        ...(Number.isFinite(record.AREA_HA)
          ? { h: Math.round(record.AREA_HA) }
          : {}),
        ...geometry(decoded),
      });
      counts[kind] += 1;
    });
}

// Natura 2000: a site in both files is one area. Its outline is the larger
// of the two registered ones (they are mostly the same).
const sites = new Map();
for (const [file, designation] of NATURA_FILES)
  for (const { records, shapes } of await shapefiles(file))
    records.forEach((record, index) => {
      const shape = shapes[index];
      const code = String(record?.SITE_CODE ?? '');
      if (!record || !shape || !/^SE\d{7}$/.test(code)) return;
      const site = sites.get(code) ?? { code, in: {}, dates: [] };
      site.in[designation] = true;
      site.dates.push(record.SPA_DATUM, record.SCI_FORSL, record.SCI_DATUM);
      const area = Number(record.AREA_HA);
      if (!site.record || area > site.area) {
        const decoded = outline(shape, TOLERANCE.natura);
        if (decoded.length) Object.assign(site, { record, area, decoded });
      }
      sites.set(code, site);
    });
const natura = [];
for (const site of sites.values()) {
  if (!site.decoded) continue;
  const year = naturaYear(...site.dates);
  natura.push({
    i: site.code,
    n: text(site.record.NAMN),
    t: 'n2k',
    d: naturaDesignation(site.in.spa, site.in.sci),
    ...(year ? { y: year } : {}),
    k: text(site.record.KOMMUN),
    ...hectares(site.record.AREA_HA),
    ...geometry(site.decoded),
  });
}
counts.n2k = natura.length;

// The access bans in force, by reason. Their descriptions stay out.
const bans = [];
for (const { records, shapes } of await shapefiles(BANS_FILE))
  records.forEach((record, index) => {
    const shape = shapes[index];
    if (!record || !shape || record.BESLSTAT !== 'Gällande') return;
    if (record.FORESKRTYP !== 'Tillträdesförbud') return;
    const reason = BAN_REASONS[record.FORESKRIFT] ?? 'other';
    if (reason === 'other' && !(Number(record.AREA_HA) >= OTHER_BAN_MIN_HA)) {
      counts.otherLeftOut = (counts.otherLeftOut ?? 0) + 1;
      return;
    }
    const decoded = outline(shape, TOLERANCE.bans);
    if (!decoded.length) return;
    const period = banPeriod(record.FRANDATUM, record.TILLDATUM);
    bans.push({
      // Its own id: one protected area may have tens of ban zones.
      i: `tf${record.OBJECTID}`,
      ...(record.NVRID ? { r: String(record.NVRID) } : {}),
      n: text(record.OBJEKTNAMN),
      t: 'ban',
      s: reason,
      ...(period ? { p: period } : {}),
      k: text(record.BERORDALAN).replace(/ Län$/, ' län'),
      ...hectares(record.AREA_HA),
      ...geometry(decoded),
    });
  });
counts.ban = bans.length;

if (
  counts.np < 25 ||
  counts.nr < 5000 ||
  counts.n2k < 4000 ||
  counts.ban < 1000
)
  throw new Error(`Too few areas: ${JSON.stringify(counts)}`);
// An outline whose box cannot hold the registered area lost its outer ring.
const boxHectares = ([w, s, e, n]) =>
  (e - w) *
  111.32 *
  Math.cos((((s + n) / 2) * Math.PI) / 180) *
  (n - s) *
  110.57 *
  100;
for (const list of [areas, natura, bans]) {
  const shrunk = list.filter(
    (area) => area.h >= 50 && boxHectares(area.b) < area.h * 0.8,
  );
  if (shrunk.length > list.length / 200)
    throw new Error(
      `${shrunk.length} outlines smaller than their area, e.g. ${shrunk
        .slice(0, 5)
        .map((area) => area.n)
        .join(', ')}`,
    );
}
const built = new Date().toISOString().slice(0, 10);
await mkdir(OUT_DIR, { recursive: true });
const sizes = [];
for (const [file, list] of [
  [OUT, areas],
  [NATURA_OUT, natura],
  [BANS_OUT, bans],
]) {
  const json = JSON.stringify({
    source: 'Naturvårdsverket',
    built,
    areas: list,
  });
  await writeFile(file, json);
  sizes.push(
    `${(json.length / 1e6).toFixed(1)} MB → ${path.relative(ROOT, file)}`,
  );
}
const tally = (list, key) =>
  Object.entries(
    list.reduce(
      (sums, area) => ({ ...sums, [area[key]]: (sums[area[key]] ?? 0) + 1 }),
      {},
    ),
  )
    .map(([value, count]) => `${value} ${count}`)
    .join(', ');
console.log(
  `${counts.np} national parks, ${counts.nr} nature reserves, ${counts.kr} culture reserves; ` +
    `${counts.n2k} Natura 2000 areas (${tally(natura, 'd')}); ` +
    `${counts.ban} access bans (${tally(bans, 's')}; ${counts.otherLeftOut ?? 0} small "other" left out)\n${sizes.join('\n')}`,
);
