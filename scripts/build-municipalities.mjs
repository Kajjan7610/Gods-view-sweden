#!/usr/bin/env node
/**
 * Build the Swedish municipality and county snapshot read by
 * /api/municipalities:
 *
 *   src/data/local_data/se_municipalities/municipalities.json
 *
 * Boundaries come from OpenStreetMap through one Overpass query: the 290
 * municipalities (admin_level 7) and 21 counties (admin_level 4) inside
 * Sweden, with every member way's geometry. Each way is simplified once
 * (Douglas–Peucker, 25 m, ends kept) and shared by the areas on both sides,
 * so neighbours meet exactly; areas are rings of signed line numbers (see
 * src/layers/municipalities/records.js). Ways tagged maritime are kept for
 * the areas but not drawn. Population is SCB's newest monthly figure per
 * municipality and county, and the figure twelve months before it
 * (statistikdatabasen TAB6473, BE0101, CC0). The snapshot is OSM data, so it
 * is licensed ODbL and says so.
 *
 * Run it by hand when boundaries or a new population year change, never from
 * the app.
 *
 * Usage:
 *   node scripts/build-municipalities.mjs [--endpoint <overpass-url>]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, createCache } from './lib/osmSnapshot.mjs';
import {
  encodeLine,
  ringPoints,
  ringsContain,
  shortMunicipalityName,
  simplifyLine,
} from '../src/layers/municipalities/records.js';

const OUT = path.join(
  ROOT,
  'src/data/local_data/se_municipalities/municipalities.json',
);
const TOLERANCE_M = 25;
// Population at the end of each month, by region (SCB, CC0).
const SCB_POPULATION =
  'https://statistikdatabasen.scb.se/api/v2/tables/TAB6473/data';

const cache = createCache('gev-municipalities');
const result = await cache.overpass(`[out:json][timeout:600];
area["ISO3166-1"="SE"]["admin_level"="2"]->.se;
rel(area.se)["boundary"="administrative"]["admin_level"~"^(4|7)$"]->.r;
.r out body;
node(r.r:"admin_centre");
out;
way(r.r);
out tags geom;`);
const osmBase = result.osm3s?.timestamp_osm_base ?? null;
const relations = result.elements.filter((e) => e.type === 'relation');
const nodes = new Map(
  result.elements
    .filter((e) => e.type === 'node')
    .map((e) => [e.id, [e.lon, e.lat]]),
);
const ways = new Map(
  result.elements
    .filter((e) => e.type === 'way')
    .map((e) => [e.id, e]),
);
const counties = relations.filter((e) => e.tags.admin_level === '4');
const municipalities = relations.filter((e) => e.tags.admin_level === '7');
if (counties.length !== 21 || municipalities.length !== 290)
  throw new Error(
    `Expected 21 counties and 290 municipalities, got ${counties.length} and ${municipalities.length}`,
  );

// One simplified line per way; a county line is any way on a county's edge.
const countyWays = new Set(
  counties.flatMap((rel) =>
    rel.members.filter((m) => m.type === 'way').map((m) => m.ref),
  ),
);
const lineOf = new Map();
const lines = [];
for (const way of ways.values()) {
  const points = way.geometry.map(({ lon, lat }) => [lon, lat]);
  const county =
    countyWays.has(way.id) || Number(way.tags?.admin_level) <= 4;
  lines.push({
    k: county ? 'c' : 'm',
    ...(way.tags?.maritime === 'yes' ? { s: 1 } : {}),
    p: encodeLine(simplifyLine(points, TOLERANCE_M)),
  });
  lineOf.set(way.id, lines.length);
}

const key = ([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
/** Join a relation's ways end to end into closed rings of signed lines. */
function assemble(rel) {
  const pool = rel.members
    .filter((m) => m.type === 'way' && ways.has(m.ref))
    .map((m) => {
      const g = ways.get(m.ref).geometry;
      return {
        line: lineOf.get(m.ref),
        start: key([g[0].lon, g[0].lat]),
        end: key([g.at(-1).lon, g.at(-1).lat]),
      };
    });
  const rings = [];
  while (pool.length) {
    const first = pool.shift();
    const ring = [first.line];
    const start = first.start;
    let end = first.end;
    while (end !== start) {
      const at = pool.findIndex((w) => w.start === end || w.end === end);
      if (at < 0)
        throw new Error(`Open ring in ${rel.tags.name} (relation ${rel.id})`);
      const [next] = pool.splice(at, 1);
      if (next.start === end) {
        ring.push(next.line);
        end = next.end;
      } else {
        ring.push(-next.line);
        end = next.start;
      }
    }
    rings.push(ring);
  }
  return rings;
}

const decoded = lines.map((line) => {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < line.p.length; i += 2) {
    x += line.p[i];
    y += line.p[i + 1];
    out.push([x / 1e5, y / 1e5]);
  }
  return out;
});

/**
 * A point well inside an area for its name: the grid point inside the
 * largest ring farthest from that ring's edge (a coarse pole of
 * inaccessibility).
 */
function labelPoint(rings) {
  const polygons = rings.map((ring) => ringPoints(ring, decoded));
  const area = (ring) =>
    Math.abs(
      ring.reduce(
        (sum, [x, y], i) =>
          sum + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y,
        0,
      ),
    );
  const largest = polygons.reduce((a, b) => (area(b) > area(a) ? b : a));
  const lons = largest.map(([lon]) => lon);
  const lats = largest.map(([, lat]) => lat);
  const [west, east] = [Math.min(...lons), Math.max(...lons)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const cos = Math.cos(((south + north) / 2) * (Math.PI / 180));
  let best = null;
  for (let i = 1; i < 24; i++)
    for (let j = 1; j < 24; j++) {
      const point = [
        west + ((east - west) * i) / 24,
        south + ((north - south) * j) / 24,
      ];
      if (!ringsContain(polygons, point)) continue;
      let near = Infinity;
      for (const [x, y] of largest)
        near = Math.min(near, ((x - point[0]) * cos) ** 2 + (y - point[1]) ** 2);
      if (!best || near > best.near) best = { point, near };
    }
  return best?.point ?? largest[0];
}
const round = ([lon, lat]) => [
  Math.round(lon * 1e5) / 1e5,
  Math.round(lat * 1e5) / 1e5,
];

// SCB's newest year-end population for every municipality and county.
const codes = [
  ...counties.map((rel) => rel.tags['ref:SE:scb'] ?? rel.tags['ref:scb']),
  ...municipalities.map((rel) => rel.tags['ref:scb'] ?? rel.tags.ref),
];
if (codes.some((code) => !/^\d{2}(\d{2})?$/.test(code ?? '')))
  throw new Error('A boundary has no SCB code');
// SCB's server refuses long addresses, so the regions go 100 at a time.
const population = new Map();
const scbName = new Map();
let periods = [];
for (let start = 0; start < codes.length; start += 100) {
  const query = new URLSearchParams({
    lang: 'sv',
    'valueCodes[Region]': codes.slice(start, start + 100).join(','),
    // Folkmängd, both sexes, the newest month and the twelve before it.
    'valueCodes[Forandringar]': '100',
    'valueCodes[Kon]': 'TotSa',
    'valueCodes[ContentsCode]': '000007SR',
    'valueCodes[Tid]': 'top(13)',
    outputFormat: 'json-stat2',
  });
  const scb = await cache.json(`${SCB_POPULATION}?${query}`);
  if (scb.id.join() !== 'Region,Forandringar,Kon,ContentsCode,Tid')
    throw new Error(`Unexpected SCB dimensions ${scb.id.join()}`);
  const tid = scb.dimension.Tid.category.index;
  periods = Object.keys(tid).sort();
  if (periods.length !== 13)
    throw new Error(`Expected 13 months, got ${periods.length}`);
  const at = (code, period) =>
    scb.value[scb.dimension.Region.category.index[code] * 13 + tid[period]] ??
    null;
  for (const [code, label] of Object.entries(scb.dimension.Region.category.label))
    scbName.set(code, label);
  for (const code of Object.keys(scb.dimension.Region.category.index))
    population.set(code, {
      now: at(code, periods.at(-1)),
      yearAgo: at(code, periods[0]),
    });
}
const populationPeriod = periods.at(-1);

const snapshot = {
  schemaVersion: 1,
  source: 'OpenStreetMap contributors',
  license: 'ODbL-1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  osmBase,
  populationSource: 'SCB, Befolkningsstatistik per månad (TAB6473)',
  populationLicense: 'CC0-1.0',
  populationPeriod,
  populationYearAgo: periods[0],
  simplifiedM: TOLERANCE_M,
  builtAt: new Date().toISOString(),
  lines,
  counties: counties
    .map((rel) => {
      const code = rel.tags['ref:SE:scb'] ?? rel.tags['ref:scb'];
      const rings = assemble(rel);
      return {
        code,
        name: scbName.get(code) ?? rel.tags.name,
        population: population.get(code)?.now ?? null,
        populationYearAgo: population.get(code)?.yearAgo ?? null,
        label: round(labelPoint(rings)),
        rings,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code)),
  municipalities: municipalities
    .map((rel) => {
      const code = rel.tags['ref:scb'] ?? rel.tags.ref;
      const rings = assemble(rel);
      const centre = rel.members.find((m) => m.role === 'admin_centre');
      const polygons = rings.map((ring) => ringPoints(ring, decoded));
      const town = centre ? nodes.get(centre.ref) : null;
      return {
        code,
        // SCB's name ("Stockholm"), not OSM's "Stockholms kommun".
        name: scbName.get(code) ?? shortMunicipalityName(rel.tags.name),
        county: code.slice(0, 2),
        population: population.get(code)?.now ?? null,
        populationYearAgo: population.get(code)?.yearAgo ?? null,
        label: round(
          town && ringsContain(polygons, town) ? town : labelPoint(rings),
        ),
        rings,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code)),
};
const missing = [...snapshot.counties, ...snapshot.municipalities].filter(
  (area) => area.population === null,
);
if (missing.length)
  throw new Error(`No population for ${missing.map((a) => a.name).join(', ')}`);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(snapshot)}\n`);
const points = lines.reduce((sum, line) => sum + line.p.length / 2, 0);
console.log(
  `${snapshot.municipalities.length} municipalities, ${snapshot.counties.length} counties, ${lines.length} lines with ${points} points (OSM ${osmBase}, population ${populationPeriod}) → ${path.relative(ROOT, OUT)}`,
);
