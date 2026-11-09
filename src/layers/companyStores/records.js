/**
 * Retail chains in Sweden: the companies the layer offers, and pure parsing
 * of their stores from OpenStreetMap, shared by the build script, the server
 * route and the layer. No Cesium, no Node built-ins.
 *
 * Stores come from OpenStreetMap (ODbL), matched on the `brand:wikidata` tag
 * that the Name Suggestion Index gives each chain (older items too), or, for
 * a shop with no such tag, on its brand or name, so they are collected by
 * mappers, not taken from the companies' own store finders. Only shops are
 * kept: no warehouses, offices, ATMs or parking.
 */

/**
 * The companies, each with the Wikidata items its stores carry as
 * `brand:wikidata`, the names an untagged store of theirs starts with, and a
 * colour per store concept (by OSM `brand`, else the name).
 */
export const COMPANIES = Object.freeze(
  [
    {
      id: 'ica',
      name: 'ICA',
      group: 'ICA Gruppen',
      wikidata: 'Q1663776',
      brandWikidata: ['Q1663776'],
      names: ['ICA'],
      concepts: [
        ['Maxi ICA Stormarknad', '#b0000b'],
        ['ICA Kvantum', '#e3000b'],
        ['ICA Supermarket', '#ff5a5f'],
        ['ICA Nära', '#ffb3b5'],
      ],
      color: '#e3000b',
    },
    {
      id: 'coop',
      name: 'Coop',
      wikidata: 'Q106684510',
      // Q15229319 is the older "Coop (Sweden)" item, still on many stores.
      brandWikidata: ['Q106684510', 'Q15229319', 'Q123402132', 'Q16951401'],
      names: ['Stora Coop', 'Coop', 'X:-tra'],
      concepts: [
        ['Stora Coop', '#00753a'],
        ['Coop', '#00aa46'],
        ['X:-tra', '#8bc34a'],
      ],
      color: '#00aa46',
    },
    {
      id: 'axfood',
      name: 'Axfood',
      wikidata: 'Q792486',
      brandWikidata: ['Q10720214', 'Q10521746'],
      names: ['Willys', 'Hemköp'],
      concepts: [
        ['Willys', '#ffd200'],
        ['Hemköp', '#ff7a00'],
      ],
      color: '#ffd200',
    },
    {
      id: 'lidl',
      name: 'Lidl',
      wikidata: 'Q151954',
      brandWikidata: ['Q151954'],
      names: ['Lidl'],
      concepts: [],
      color: '#0050aa',
    },
    {
      id: 'city-gross',
      name: 'City Gross',
      wikidata: 'Q10453555',
      brandWikidata: ['Q10453555'],
      names: ['City Gross'],
      concepts: [],
      color: '#8e24aa',
    },
    {
      id: 'systembolaget',
      name: 'Systembolaget',
      stateOwned: true,
      wikidata: 'Q1476113',
      brandWikidata: ['Q1476113'],
      names: ['Systembolaget'],
      concepts: [],
      color: '#f5f5f5',
    },
    // Pharmacy chains: OSM maps them as amenity=pharmacy, not as shops.
    {
      id: 'apotek-hjartat',
      name: 'Apotek Hjärtat',
      group: 'ICA Gruppen',
      kind: 'pharmacy',
      wikidata: 'Q10416114',
      brandWikidata: ['Q10416114'],
      names: ['Apotek Hjärtat'],
      concepts: [],
      color: '#ec407a',
    },
    {
      id: 'apoteket',
      name: 'Apoteket',
      stateOwned: true,
      kind: 'pharmacy',
      wikidata: 'Q1785637',
      brandWikidata: ['Q1785637'],
      names: ['Apoteket'],
      concepts: [],
      color: '#00897b',
    },
    {
      id: 'kronans-apotek',
      name: 'Kronans Apotek',
      kind: 'pharmacy',
      wikidata: 'Q10549422',
      brandWikidata: ['Q10549422'],
      names: ['Kronans Apotek'],
      concepts: [],
      color: '#4dd0e1',
    },
    {
      id: 'apoteksgruppen',
      name: 'Apoteksgruppen',
      kind: 'pharmacy',
      wikidata: 'Q10416129',
      brandWikidata: ['Q10416129'],
      names: ['Apoteksgruppen'],
      concepts: [],
      color: '#7986cb',
    },
    {
      id: 'doz-apotek',
      name: 'DOZ Apotek',
      kind: 'pharmacy',
      wikidata: 'Q10475311',
      brandWikidata: ['Q10475311'],
      // Lloyds Apotek became DOZ Apotek; old names linger on the map.
      names: ['DOZ Apotek', 'Lloyds Apotek'],
      concepts: [],
      color: '#a1887f',
    },
  ].map((company) =>
    Object.freeze({
      kind: 'store',
      ...company,
      brandWikidata: Object.freeze(company.brandWikidata),
      names: Object.freeze(company.names),
      concepts: Object.freeze(
        company.concepts.map(([brand, color]) =>
          Object.freeze({ brand, color }),
        ),
      ),
    }),
  ),
);

/** Shop kinds kept as stores; anything else carrying the brand is dropped. */
export const STORE_SHOPS = Object.freeze([
  'supermarket',
  'convenience',
  'alcohol',
  'department_store',
  'wholesale',
]);

/** Whether a mapped place is a store of its company's kind. */
export function isStoreOfKind(company, tags) {
  if (company?.kind === 'pharmacy')
    return tags.amenity === 'pharmacy' || tags.healthcare === 'pharmacy';
  return STORE_SHOPS.includes(tags.shop);
}

const BY_BRAND_WIKIDATA = new Map(
  COMPANIES.flatMap((company) =>
    company.brandWikidata.map((id) => [id, company]),
  ),
);

export function companyById(id) {
  return COMPANIES.find((company) => company.id === id) || null;
}

/** The colour of a store: its concept's, else its company's. */
export function storeColor(store) {
  const company = companyById(store?.company);
  if (!company) return '#9e9e9e';
  return (
    company.concepts.find((concept) => concept.brand === store.brand)?.color ||
    company.color
  );
}

const text = (value, max) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** A one-line address from OSM `addr:*` tags, or null. */
export function storeAddress(tags) {
  const street = [
    text(tags['addr:street'], 80),
    text(tags['addr:housenumber'], 12),
  ]
    .filter(Boolean)
    .join(' ');
  const place = [text(tags['addr:postcode'], 8), text(tags['addr:city'], 60)]
    .filter(Boolean)
    .join(' ');
  return [street, place].filter(Boolean).join(', ') || null;
}

/** The store's own web page, when mappers gave an http(s) link. */
export function storeWebsite(tags) {
  const url = text(tags.website || tags['contact:website'], 200);
  return url && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/**
 * The area in m² of a store mapped as an outline (an Overpass way with
 * `geometry`), rounded to 10 m², or null for points and implausible shapes.
 */
export function outlineArea(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 4) return null;
  const lat0 = (geometry[0].lat * Math.PI) / 180;
  const m = 6371008.8 * (Math.PI / 180);
  let sum = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    sum +=
      a.lon * Math.cos(lat0) * m * (b.lat * m) -
      b.lon * Math.cos(lat0) * m * (a.lat * m);
  }
  const area = Math.abs(sum) / 2;
  return area >= 30 && area <= 60_000 ? Math.round(area / 10) * 10 : null;
}

/** Brand spellings mappers use for a concept, read as that concept. */
const BRAND_ALIASES = new Map([
  ['ica maxi', 'Maxi ICA Stormarknad'],
  ['maxi ica', 'Maxi ICA Stormarknad'],
  ['coop (sweden)', 'Coop'],
  ['coop konsum', 'Coop'],
  ['coop nära', 'Coop'],
  ['coop forum', 'Stora Coop'],
]);

/** Whether `value` is `prefix` or starts with it as a whole word. */
function startsWithWord(value, prefix) {
  const a = value.toLowerCase();
  const b = prefix.toLowerCase();
  return a === b || a.startsWith(`${b} `);
}

/** The concept a brand or name starts with, longest match first. */
function conceptOf(company, value) {
  if (!value) return null;
  const candidates = [
    ...company.concepts.map((concept) => [concept.brand, concept.brand]),
    ...BRAND_ALIASES.entries(),
  ].filter(([, brand]) =>
    company.concepts.some((concept) => concept.brand === brand),
  );
  candidates.sort((a, b) => b[0].length - a[0].length);
  return (
    candidates.find(([prefix]) => startsWithWord(value, prefix))?.[1] ?? null
  );
}

/**
 * The store's concept: what its name starts with (a brand of "ICA" or "Coop"
 * says less than "ICA Nära Bagarmossen" or "Stora Coop Bromma"), else what
 * its brand (the first of several `;`-separated ones) starts with, else the
 * brand as tagged or the company's name.
 */
export function canonicalBrand(company, brand, name = null) {
  const first = text(String(brand ?? '').split(';')[0], 60);
  return (
    conceptOf(company, text(name, 80)) ||
    conceptOf(company, first) ||
    first ||
    company.name
  );
}

/**
 * The company of a shop that carries no `brand:wikidata`, from the brand or
 * name it starts with; a shop tagged with another item is someone else's.
 */
export function companyByName(tags) {
  if (tags['brand:wikidata']) return null;
  const value = text(tags.brand, 80) || text(tags.name, 80);
  if (!value) return null;
  return (
    COMPANIES.find((company) =>
      company.names.some((prefix) => startsWithWord(value, prefix)),
    ) || null
  );
}

/**
 * One store from an Overpass element, or null when it is not a shop of a
 * known company or has no place in Sweden's box.
 * @param {object} element An Overpass element with `tags` and a position
 *   (`lat`/`lon` for nodes, `center` for ways and relations).
 */
export function normalizeStore(element) {
  const tags = element?.tags || {};
  const company =
    BY_BRAND_WIKIDATA.get(tags['brand:wikidata']) || companyByName(tags);
  const bounds = element?.bounds;
  const lat = Number(
    element?.center?.lat ??
      element?.lat ??
      (bounds ? (bounds.minlat + bounds.maxlat) / 2 : NaN),
  );
  const lon = Number(
    element?.center?.lon ??
      element?.lon ??
      (bounds ? (bounds.minlon + bounds.maxlon) / 2 : NaN),
  );
  const type = { node: 'n', way: 'w', relation: 'r' }[element?.type];
  if (
    !company ||
    !type ||
    !Number.isInteger(element.id) ||
    !isStoreOfKind(company, tags) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 55 ||
    lat > 69.2 ||
    lon < 10.5 ||
    lon > 24.2
  )
    return null;
  const checked = String(
    tags['check_date:opening_hours'] || tags.check_date || '',
  ).match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  const post =
    tags.post_office && tags.post_office !== 'no'
      ? text(tags['post_office:brand'], 40) || ''
      : null;
  const extra = {
    website: storeWebsite(tags),
    phone: text(tags.phone || tags['contact:phone'], 40),
    wheelchair: ['yes', 'limited', 'no'].includes(tags.wheelchair)
      ? tags.wheelchair
      : null,
    post,
    area: type === 'w' ? outlineArea(element.geometry) : null,
    checked: checked || null,
  };
  return {
    id: `${type}${element.id}`,
    company: company.id,
    // A pharmacy chain has one concept: its own name, whatever the tags add.
    brand:
      company.kind === 'pharmacy'
        ? company.name
        : canonicalBrand(company, tags.brand, tags.name),
    name: text(tags.name, 80) || text(tags.brand, 60) || company.name,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    address: storeAddress(tags),
    hours: text(tags.opening_hours, 160),
    // Only what is known, to keep the snapshot small.
    ...Object.fromEntries(
      Object.entries(extra).filter(([, value]) => value !== null),
    ),
  };
}

/** Every store of the given elements, once each, sorted by company and name. */
export function normalizeStores(elements) {
  if (!Array.isArray(elements)) throw new Error('Malformed store collection');
  const seen = new Set();
  const order = (row) => COMPANIES.findIndex((c) => c.id === row.company);
  return elements
    .map(normalizeStore)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id))
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        a.name.localeCompare(b.name, 'sv') ||
        a.id.localeCompare(b.id),
    );
}

/** Store counts per company and per concept. */
export function storeCounts(stores) {
  const counts = {};
  for (const row of stores) {
    const entry = (counts[row.company] ??= { total: 0, brands: {} });
    entry.total++;
    entry.brands[row.brand] = (entry.brands[row.brand] || 0) + 1;
  }
  return counts;
}
