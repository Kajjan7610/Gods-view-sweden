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
 * instances are shared. OVERPASS_UPSTREAMS (first URL) wins over --endpoint;
 * busy instances are retried in turn. Each answer is kept for 12 hours in
 * the system temp directory, so a run cut short resumes where it stopped.
 *
 * Usage:
 *   node scripts/build-company-stores.mjs [--endpoint <overpass-url>]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
// Tried in order; a busy public instance answers 504 and the next is asked.
const ENDPOINTS = [
  (process.env.OVERPASS_UPSTREAMS || '').split(',')[0].trim(),
  argEndpoint,
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter(Boolean);

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

const CACHE = path.join(os.tmpdir(), 'gev-company-stores');
const CACHE_MS = 12 * 60 * 60_000;

async function overpass(query) {
  const file = path.join(
    CACHE,
    `${createHash('sha256').update(query).digest('hex').slice(0, 16)}.json`,
  );
  try {
    if (Date.now() - (await stat(file)).mtimeMs < CACHE_MS)
      return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Not cached yet.
  }
  for (let attempt = 1; attempt <= 3 * ENDPOINTS.length; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    let status;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      });
      const body = await response.text();
      if (response.ok && body.startsWith('{')) {
        await mkdir(CACHE, { recursive: true });
        await writeFile(file, body);
        return JSON.parse(body);
      }
      status = `HTTP ${response.status}`;
    } catch (error) {
      status = error?.cause?.code || error?.name || 'network error';
    }
    console.warn(`  ${new URL(endpoint).host} ${status}, attempt ${attempt}`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
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
// The oldest data any answer came from, so the snapshot never claims more.
let osmBase = null;
/** A name as a literal inside an Overpass regular expression. */
const escape = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
for (const company of COMPANIES) {
  console.log(company.name);
  // Its brand items, then shops with no brand item named like its stores.
  const result = await overpass(
    `[out:json][timeout:180][bbox:${BOX}];(` +
      `nwr["brand:wikidata"~"^(${company.brandWikidata.join('|')})$"];` +
      `nwr["shop"][!"brand:wikidata"]["name"~"^(${company.names.map(escape).join('|')})( |$)"];` +
      `nwr["shop"][!"brand:wikidata"]["brand"~"^(${company.names.map(escape).join('|')})( |$)"];` +
      `);out tags center;`,
  );
  const base = result.osm3s?.timestamp_osm_base ?? null;
  if (base && (!osmBase || base < osmBase)) osmBase = base;
  elements.push(...result.elements);
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
