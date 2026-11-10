#!/usr/bin/env node
/**
 * Build the Swedish retail-chain store snapshot read by /api/company-stores:
 *
 *   src/data/local_data/se_company_stores/stores.json
 *
 * Stores come from OpenStreetMap through one Overpass query per brand
 * (`brand:wikidata`, a box around Sweden), kept when they are a shop
 * (src/layers/companyStores/records.js) and lie in Sweden by the bundled
 * Natural Earth boundary; points just off the simplified coast go to the
 * nearest country the box reaches (Norway to Russia, so Baltic stores are
 * not taken for Swedish ones). Company facts (legal name, organisation
 * number, and the head office when it lies in Sweden) come from Wikidata.
 * Each store also gets the nearest named public-transport stop within 600 m
 * (OSM) and the people living within 2 km, summed from SCB's open 1 km
 * population grid (geodata.scb.se, CC0, newest year), and its ground height
 * above the ellipsoid from Re:Earth Terrain (Mapterhorn, CC BY 4.0). The
 * snapshot is OSM data, so it is licensed ODbL and says so.
 *
 * Run it by hand, about weekly, never from the app: public Overpass
 * instances are shared. OVERPASS_UPSTREAMS (first URL) wins over --endpoint;
 * busy instances are retried in turn. Each answer is kept for 12 hours in
 * the system temp directory, so a run cut short resumes where it stopped.
 *
 * A run that finds no stores at all, or over 20 % fewer for some company
 * than the snapshot on disk holds, stops before anything is written: a
 * mirror that answers with half the data must not replace a good snapshot.
 * --force writes it anyway (a chain that really closed that many stores).
 *
 * Usage:
 *   node scripts/build-company-stores.mjs [--endpoint <overpass-url>] [--force]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  COMPANIES,
  distanceMeters,
  normalizeStores,
  storeCounts,
  tidyStores,
} from '../src/layers/companyStores/records.js';
import {
  BOX,
  ROOT,
  countries,
  countryOf,
  createCache,
} from './lib/osmSnapshot.mjs';

const OUT = path.join(
  ROOT,
  'src/data/local_data/se_company_stores/stores.json',
);
const STOP_RADIUS_M = 600;
const POPULATION_RADIUS_M = 2000;
const SCB_WFS = 'https://geodata.scb.se/geoserver/stat/wfs';
/** The share of a company's stores a new snapshot may lose, in per cent. */
const MAX_DROP_PERCENT = 20;
const force = process.argv.includes('--force');

const cache = createCache('gev-company-stores');
const overpass = cache.overpass;
const cachedJson = cache.json;

/** WGS84 to SWEREF 99 TM (EPSG:3006), Lantmäteriet's Gauss–Krüger formulas. */
function sweref99tm([lon, lat]) {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const n = f / (2 - f);
  const aRoof = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const A = e2;
  const B = (5 * e2 ** 2 - e2 ** 3) / 6;
  const C = (104 * e2 ** 3 - 45 * e2 ** 4) / 120;
  const D = (1237 * e2 ** 4) / 1260;
  const betas = [
    n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180,
    (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440,
    (61 * n ** 3) / 240 - (103 * n ** 4) / 140,
    (49561 * n ** 4) / 161280,
  ];
  const phi = (lat * Math.PI) / 180;
  const dLambda = ((lon - 15) * Math.PI) / 180;
  const s2 = Math.sin(phi) ** 2;
  const phiStar =
    phi -
    Math.sin(phi) * Math.cos(phi) * (A + B * s2 + C * s2 ** 2 + D * s2 ** 3);
  const xi = Math.atan(Math.tan(phiStar) / Math.cos(dLambda));
  const eta = Math.atanh(Math.cos(phiStar) * Math.sin(dLambda));
  let x = xi;
  let y = eta;
  betas.forEach((beta, i) => {
    const k = 2 * (i + 1);
    x += beta * Math.sin(k * xi) * Math.cosh(k * eta);
    y += beta * Math.cos(k * xi) * Math.sinh(k * eta);
  });
  return { north: 0.9996 * aRoof * x, east: 0.9996 * aRoof * y + 500000 };
}

/** SCB's newest 1 km population grid: people by cell south-west corner. */
async function populationGrid() {
  // An answer that lists no grid (an error page) is asked for again.
  const newest = (capabilities) => {
    const years = [
      ...capabilities.matchAll(/stat:befolkning_1km_(\d{4})</g),
    ].map((match) => Number(match[1]));
    if (!years.length) throw new Error('No SCB population grid');
    return Math.max(...years);
  };
  const year = newest(
    await cache.text(
      `${SCB_WFS}?service=WFS&version=2.0.0&request=GetCapabilities`,
      newest,
    ),
  );
  const cells = new Map();
  for (let start = 0; ; start += 50_000) {
    const url = new URL(SCB_WFS);
    url.search = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: `stat:befolkning_1km_${year}`,
      propertyName: 'rutid_scb,beftotalt',
      sortBy: 'objectid',
      count: '50000',
      startIndex: String(start),
      outputFormat: 'application/json',
    }).toString();
    const page = await cachedJson(url.toString());
    for (const feature of page.features) {
      // "3940006133000": easting 394000, northing 6133000.
      const id = String(feature.properties.rutid_scb);
      cells.set(
        `${id.slice(0, 6)},${id.slice(6)}`,
        Number(feature.properties.beftotalt) || 0,
      );
    }
    if (page.features.length < 50_000) break;
  }
  return { year, cells };
}

/** People in the 1 km cells whose centres lie within the radius of a point. */
function populationNear(grid, point) {
  const { north, east } = sweref99tm(point);
  const reach = POPULATION_RADIUS_M + 1000;
  let total = 0;
  for (
    let e = Math.floor((east - reach) / 1000) * 1000;
    e <= east + reach;
    e += 1000
  )
    for (
      let n = Math.floor((north - reach) / 1000) * 1000;
      n <= north + reach;
      n += 1000
    )
      if (Math.hypot(e + 500 - east, n + 500 - north) <= POPULATION_RADIUS_M)
        total += grid.cells.get(`${e},${n}`) || 0;
  return total;
}

/** A named public-transport stop from an Overpass element, or null. */
function stopOf(element) {
  const tags = element.tags || {};
  const name =
    typeof tags.name === 'string' ? tags.name.trim().slice(0, 60) : '';
  const lat = element.center?.lat ?? element.lat;
  const lon = element.center?.lon ?? element.lon;
  const isStop =
    tags.highway === 'bus_stop' ||
    ['platform', 'station'].includes(tags.public_transport) ||
    ['station', 'halt', 'tram_stop'].includes(tags.railway);
  // Platform letters and numbers ("B", "C1") name no place.
  const placeName = name && !/^[A-Z]?\d{0,3}[a-z]?$/i.test(name);
  return isStop && placeName && Number.isFinite(lat) && Number.isFinite(lon)
    ? { name, point: [lon, lat] }
    : null;
}

/** Wikidata items by id, with their Swedish and English labels and claims. */
async function wikidataEntities(ids) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|claims',
    languages: 'sv|en',
    format: 'json',
  }).toString();
  // Wikidata answers 200 with an `error` for a request it refuses.
  const answer = await cachedJson(url.toString(), (body) => {
    if (!body.entities)
      throw new Error(String(body.error?.info || 'no entities').slice(0, 80));
  });
  return answer.entities;
}

/**
 * What the store card says about each company: legal name, organisation
 * number and head office. The head office is kept only when it lies in
 * Sweden, so a Swedish organisation number is not paired with the parent's
 * seat abroad (Lidl: Neckarsulm).
 */
async function wikidataFacts(ids) {
  const entities = await wikidataEntities(ids);
  const value = (entity, property) =>
    entity?.claims?.[property]?.map((claim) => claim.mainsnak.datavalue?.value);
  const places = [
    ...new Set(
      Object.values(entities).flatMap((entity) =>
        (value(entity, 'P159') || []).map((v) => v?.id).filter(Boolean),
      ),
    ),
  ];
  const placeEntities = places.length ? await wikidataEntities(places) : {};
  const label = (entity) =>
    entity?.labels?.sv?.value || entity?.labels?.en?.value || null;
  // Country (P17) Sweden (Q34).
  const inSweden = (place) =>
    (value(place, 'P17') || []).some((country) => country?.id === 'Q34');
  const facts = {};
  for (const id of ids) {
    const entity = entities[id];
    const seat = placeEntities[(value(entity, 'P159') || [])[0]?.id];
    facts[id] = {
      legalName: label(entity),
      orgNumber: (value(entity, 'P6460') || [])[0] || null,
      headOffice: inSweden(seat) ? label(seat) : null,
    };
  }
  return facts;
}

/**
 * Stores per company in the snapshot on disk, with the former company ids
 * folded into today's (tidyStores), or null when there is no snapshot yet.
 */
async function previousCounts() {
  let previous;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(
      `Cannot read ${path.relative(ROOT, OUT)} to compare with (${error.message}); --force overwrites it`,
    );
  }
  return storeCounts(
    tidyStores(Array.isArray(previous.stores) ? previous.stores : []),
  );
}

/**
 * Stop before a thin answer replaces a good snapshot: no stores at all, or
 * a company with over 20 % fewer stores than the snapshot on disk.
 */
async function refuseThinSnapshot(stores) {
  const counts = storeCounts(stores);
  const before = (await previousCounts()) || {};
  const lost = COMPANIES.map((company) => ({
    name: company.name,
    was: before[company.id]?.total ?? 0,
    now: counts[company.id]?.total ?? 0,
  })).filter(({ was, now }) => (was - now) * 100 > was * MAX_DROP_PERCENT);
  if (stores.length && !lost.length) return;
  console.error(
    stores.length
      ? `Not writing ${path.relative(ROOT, OUT)}: over ${MAX_DROP_PERCENT} % fewer stores than the snapshot on disk for`
      : `Not writing ${path.relative(ROOT, OUT)}: no stores found`,
  );
  for (const { name, was, now } of lost)
    console.error(`  ${name}: ${was} -> ${now}`);
  console.error(
    'Run it again later (a mirror may have answered with part of the data), or pass --force to write it anyway.',
  );
  process.exit(1);
}

const byIso = await countries();
const elements = [];
const stops = new Map();
// The oldest data any answer came from, so the snapshot never claims more.
let osmBase = null;
/** A name as a literal inside an Overpass regular expression. */
const escape = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
for (const company of COMPANIES) {
  console.log(company.name);
  // Its brand items, then shops (pharmacies for a pharmacy chain) with no
  // brand item named like its stores.
  const place =
    company.kind === 'pharmacy' ? '["amenity"="pharmacy"]' : '["shop"]';
  const result = await overpass(
    `[out:json][timeout:180][bbox:${BOX}];(` +
      `nwr["brand:wikidata"~"^(${company.brandWikidata.join('|')})$"];` +
      `nwr${place}[!"brand:wikidata"]["name"~"^(${company.names.map(escape).join('|')})( |$)"];` +
      `nwr${place}[!"brand:wikidata"]["brand"~"^(${company.names.map(escape).join('|')})( |$)"];` +
      // Outlines give the mapped area; then the named stops near them.
      `)->.s;.s out tags geom;(` +
      `node(around.s:${STOP_RADIUS_M})["highway"="bus_stop"];` +
      `nwr(around.s:${STOP_RADIUS_M})["public_transport"~"^(platform|station)$"];` +
      `nwr(around.s:${STOP_RADIUS_M})["railway"~"^(station|halt|tram_stop)$"];` +
      `);out tags center;`,
  );
  const base = result.osm3s?.timestamp_osm_base ?? null;
  if (base && (!osmBase || base < osmBase)) osmBase = base;
  for (const element of result.elements) {
    const stop =
      element.tags?.shop || element.tags?.amenity === 'pharmacy'
        ? null
        : stopOf(element);
    if (stop) stops.set(`${element.type}${element.id}`, stop);
    else elements.push(element);
  }
}
const stores = normalizeStores(elements).filter(
  (row) => countryOf(byIso, row.point) === 'SWE',
);
// Checked here, before the grid, the heights and Wikidata are asked for.
if (!force) await refuseThinSnapshot(stores);
console.log(`${stops.size} stops; SCB population grid`);
const grid = await populationGrid();
const stopList = [...stops.values()];
for (const row of stores) {
  let best = null;
  for (const stop of stopList) {
    if (Math.abs(stop.point[1] - row.point[1]) > 0.01) continue;
    const distance = distanceMeters(row.point, stop.point);
    if (distance <= STOP_RADIUS_M && (!best || distance < best.distance))
      best = { name: stop.name, distance: Math.round(distance) };
  }
  if (best) row.stop = best;
  row.population = populationNear(grid, row.point);
}
// Ground height above the ellipsoid, so the layer can draw each store on the
// ground without clamping 3,000 points to photorealistic 3D tiles: Cesium
// re-picks every clamped point inside each tile as it streams in.
console.log('Re:Earth ground heights');
await cache.groundHeights(stores);
const facts = await wikidataFacts(COMPANIES.map((company) => company.wikidata));
const snapshot = {
  schemaVersion: 1,
  source: 'OpenStreetMap contributors',
  license: 'ODbL-1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  osmBase,
  populationSource: 'SCB, Befolkning 1 km-rutor',
  populationLicense: 'CC0-1.0',
  populationYear: grid.year,
  heightSource: 'Re:Earth Terrain (Mapterhorn, CC BY 4.0), metres above WGS84',
  builtAt: new Date().toISOString(),
  companies: COMPANIES.map((company) => ({
    id: company.id,
    wikidata: company.wikidata,
    ...facts[company.wikidata],
  })),
  stores,
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(snapshot)}\n`);
const counts = storeCounts(stores);
for (const company of COMPANIES)
  console.log(
    `${company.name}: ${counts[company.id]?.total ?? 0}`,
    JSON.stringify(counts[company.id]?.brands ?? {}),
  );
console.log(`wrote ${path.relative(ROOT, OUT)} (${stores.length} stores)`);
