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
 * nearest of Sweden and its neighbours. Company facts (organisation number,
 * head office, website, founded) come from Wikidata. The snapshot is OSM
 * data, so it is licensed ODbL and says so.
 *
 * Run it by hand, about weekly, never from the app: public Overpass
 * instances are shared. OVERPASS_UPSTREAMS (first URL) wins over --endpoint.
 *
 * Usage:
 *   node scripts/build-company-stores.mjs [--endpoint <overpass-url>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANIES,
  normalizeStores,
  storeCounts,
} from '../src/layers/companyStores/records.js';
import { decodeRing, polygonsContain } from '../src/data/adminBoundaries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(
  ROOT,
  'src/data/local_data/se_company_stores/stores.json',
);
const USER_AGENT =
  'gods-eye-view-sverige/0.1 (+https://github.com/Kajjan7610/Gods-view-sweden)';
const BOX = '55.0,10.5,69.2,24.2';
const argEndpoint = process.argv.includes('--endpoint')
  ? process.argv[process.argv.indexOf('--endpoint') + 1]
  : null;
const ENDPOINT =
  (process.env.OVERPASS_UPSTREAMS || '').split(',')[0].trim() ||
  argEndpoint ||
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

async function countries() {
  const pack = JSON.parse(
    await readFile(
      path.join(ROOT, 'src/data/local_data/natural_earth/countries.json'),
      'utf8',
    ),
  );
  const decimals = pack.meta.decimals;
  const byIso = {};
  for (const feature of pack.features) {
    if (!['SWE', 'NOR', 'FIN', 'DNK'].includes(feature.iso)) continue;
    byIso[feature.iso] = feature.polygons.map((poly) =>
      poly.map((ring) => decodeRing(ring, decimals)),
    );
  }
  return byIso;
}

/** The country a point belongs to: containing polygon, else nearest vertex. */
function countryOf(byIso, [lon, lat]) {
  for (const [iso, polygons] of Object.entries(byIso))
    if (polygonsContain(polygons, lat, lon)) return iso;
  let best = null;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (const [iso, polygons] of Object.entries(byIso))
    for (const [outer] of polygons)
      for (const [x, y] of outer) {
        const d = ((x - lon) * cos) ** 2 + (y - lat) ** 2;
        if (!best || d < best.d) best = { iso, d };
      }
  return best?.iso ?? null;
}

async function overpass(query) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ data: query }),
    });
    const body = await response.text();
    if (response.ok && body.startsWith('{')) return JSON.parse(body);
    console.warn(`  Overpass HTTP ${response.status}, attempt ${attempt}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 20_000));
  }
  throw new Error('Overpass unavailable');
}

async function wikidataFacts(ids) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|claims',
    languages: 'sv|en',
    format: 'json',
  }).toString();
  const entities = (
    await (await fetch(url, { headers: { 'User-Agent': USER_AGENT } })).json()
  ).entities;
  const value = (entity, property) =>
    entity?.claims?.[property]?.map((claim) => claim.mainsnak.datavalue?.value);
  const places = [
    ...new Set(
      Object.values(entities).flatMap((entity) =>
        (value(entity, 'P159') || []).map((v) => v?.id).filter(Boolean),
      ),
    ),
  ];
  const placeEntities = places.length
    ? (
        await (
          await fetch(
            `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${places.join('|')}&props=labels&languages=sv|en&format=json`,
            { headers: { 'User-Agent': USER_AGENT } },
          )
        ).json()
      ).entities
    : {};
  const label = (entity) =>
    entity?.labels?.sv?.value || entity?.labels?.en?.value || null;
  const facts = {};
  for (const id of ids) {
    const entity = entities[id];
    const websites = value(entity, 'P856') || [];
    facts[id] = {
      legalName: label(entity),
      orgNumber: (value(entity, 'P6460') || [])[0] || null,
      headOffice: label(placeEntities[(value(entity, 'P159') || [])[0]?.id]),
      website:
        websites.find((site) => /\.se\/?$/.test(site)) || websites[0] || null,
      founded:
        Number((value(entity, 'P571') || [])[0]?.time?.slice(1, 5)) || null,
    };
  }
  return facts;
}

const byIso = await countries();
const elements = [];
let osmBase = null;
for (const company of COMPANIES) {
  for (const id of company.brandWikidata) {
    console.log(`${company.name} (${id})`);
    const result = await overpass(
      `[out:json][timeout:180][bbox:${BOX}];nwr["brand:wikidata"="${id}"];out tags center;`,
    );
    osmBase = result.osm3s?.timestamp_osm_base ?? osmBase;
    elements.push(...result.elements);
  }
}
const stores = normalizeStores(elements).filter(
  (row) => countryOf(byIso, row.point) === 'SWE',
);
const facts = await wikidataFacts(COMPANIES.map((company) => company.wikidata));
const snapshot = {
  schemaVersion: 1,
  source: 'OpenStreetMap contributors',
  license: 'ODbL-1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  osmBase,
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
