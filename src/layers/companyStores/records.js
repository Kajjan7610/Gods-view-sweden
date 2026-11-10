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
 * `brand:wikidata`, the names an untagged store of theirs starts with, the
 * domains its stores' web pages are on, and a colour per store concept (by
 * OSM `brand`, else the name).
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
      domains: ['ica.se'],
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
      domains: ['coop.se', 'coopvarmland.se', 'x-tra.se'],
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
      // Q10453555 is City Gross, one of Axfood's chains.
      brandWikidata: ['Q10720214', 'Q10521746', 'Q10453555'],
      names: ['Willys', 'Hemköp', 'City Gross'],
      domains: ['willys.se', 'hemkop.se', 'citygross.se'],
      concepts: [
        ['Willys', '#ffd200'],
        ['Hemköp', '#ff7a00'],
        ['City Gross', '#8e24aa'],
      ],
      color: '#ffd200',
    },
    {
      id: 'lidl',
      name: 'Lidl',
      wikidata: 'Q151954',
      brandWikidata: ['Q151954'],
      names: ['Lidl'],
      domains: ['lidl.se'],
      concepts: [],
      color: '#0050aa',
    },
    {
      id: 'systembolaget',
      name: 'Systembolaget',
      stateOwned: true,
      wikidata: 'Q1476113',
      brandWikidata: ['Q1476113'],
      names: ['Systembolaget'],
      domains: ['systembolaget.se'],
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
      names: ['Apotek Hjärtat', 'Apoteket Hjärtat'],
      domains: ['apotekhjartat.se'],
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
      domains: ['apoteket.se'],
      concepts: [],
      color: '#00897b',
    },
    {
      id: 'kronans-apotek',
      name: 'Kronans Apotek',
      kind: 'pharmacy',
      wikidata: 'Q10549422',
      // Q10416129 is Apoteksgruppen, now part of Kronans Apotek.
      brandWikidata: ['Q10549422', 'Q10416129'],
      names: ['Kronans Apotek', 'Apoteksgruppen'],
      domains: ['kronansapotek.se', 'apoteksgruppen.se'],
      concepts: [],
      color: '#4dd0e1',
    },
    {
      id: 'doz-apotek',
      name: 'DOZ Apotek',
      kind: 'pharmacy',
      wikidata: 'Q10475311',
      brandWikidata: ['Q10475311'],
      // Lloyds Apotek became DOZ Apotek; old names linger on the map.
      names: ['DOZ Apotek', 'Lloyds Apotek'],
      domains: ['dozapotek.se'],
      concepts: [],
      color: '#a1887f',
    },
  ].map((company) =>
    Object.freeze({
      kind: 'store',
      ...company,
      brandWikidata: Object.freeze(company.brandWikidata),
      names: Object.freeze(company.names),
      domains: Object.freeze(company.domains),
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

const BY_ID = new Map(COMPANIES.map((company) => [company.id, company]));

export function companyById(id) {
  return BY_ID.get(id) || null;
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

const WEB_LINK = /^https?:\/\/\S+$/i;

/** The store's own web page, when mappers gave an http(s) link. */
export function storeWebsite(tags) {
  const url = text(tags.website || tags['contact:website'], 200);
  return url && WEB_LINK.test(url) ? url : null;
}

/**
 * A store's link when it leads to one of its company's own domains, read as
 * https, else null: anyone can edit the map, and the card opens the link.
 */
export function chainWebsite(company, url) {
  if (typeof url !== 'string' || !WEB_LINK.test(url)) return null;
  let link;
  try {
    link = new URL(url);
  } catch {
    return null;
  }
  if (link.username || link.password) return null;
  const host = link.hostname;
  if (
    !company?.domains?.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  )
    return null;
  return url.replace(/^http:/i, 'https:');
}

/** Great-circle metres between two `[lon, lat]` points. */
export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
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

const NAME_PREFIXES = COMPANIES.flatMap((company) =>
  company.names.map((prefix) => [prefix.toLowerCase(), company]),
).sort((a, b) => b[0].length - a[0].length);

/**
 * The company whose store names `value` starts with, longest name first;
 * with a `kind`, among the companies of that kind only.
 */
function companyOfName(value, kind = null) {
  if (!value) return null;
  const name = value.toLowerCase();
  for (const [prefix, company] of NAME_PREFIXES)
    if (
      (!kind || company.kind === kind) &&
      name.startsWith(prefix) &&
      (name.length === prefix.length || name[prefix.length] === ' ')
    )
      return company;
  return null;
}

/**
 * The company of a shop that carries no `brand:wikidata`, from the brand or
 * name it starts with; a shop tagged with another item is someone else's.
 */
export function companyByName(tags) {
  if (tags['brand:wikidata']) return null;
  return companyOfName(text(tags.brand, 80) || text(tags.name, 80));
}

/**
 * The chain of a pharmacy: the one its name starts with, else the one it is
 * tagged as. "Apoteket" alone is Swedish for "the pharmacy" and moves none.
 */
function pharmacyChain(company, name) {
  if (company.kind !== 'pharmacy') return company;
  const named = companyOfName(name, 'pharmacy');
  return named && named.id !== 'apoteket' ? named : company;
}

/** A pharmacy chain has one concept: its own name, whatever the tags add. */
const brandOf = (company, brand, name) =>
  company.kind === 'pharmacy'
    ? company.name
    : canonicalBrand(company, brand, name);

/** An agent ("ombud") hands out orders in someone else's shop: not a store. */
const AGENT = /\bombud\b/i;

/**
 * One store from an Overpass element, or null when it is not a shop of a
 * known company, is an agent's or has no place in Sweden's box.
 * @param {object} element An Overpass element with `tags` and a position
 *   (`lat`/`lon` for nodes, `center` for ways and relations).
 */
export function normalizeStore(element) {
  const tags = element?.tags || {};
  const tagged =
    BY_BRAND_WIKIDATA.get(tags['brand:wikidata']) || companyByName(tags);
  const company = tagged && pharmacyChain(tagged, text(tags.name, 80));
  const name =
    text(tags.name, 80) || text(tags.brand, 60) || company?.name || '';
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
    AGENT.test(name) ||
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
    website: chainWebsite(company, storeWebsite(tags)),
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
    brand: brandOf(company, tags.brand, tags.name),
    name,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    address: storeAddress(tags),
    hours: text(tags.opening_hours, 160),
    // Only what is known, to keep the snapshot small.
    ...Object.fromEntries(
      Object.entries(extra).filter(([, value]) => value !== null),
    ),
  };
}

/** Company ids of earlier snapshots, and the company their stores are now. */
const FORMER_COMPANIES = new Map([
  ['city-gross', 'axfood'],
  ['apoteksgruppen', 'kronans-apotek'],
]);

/** Within this, two places of one company are one store. */
const SAME_STORE_M = 20;
/** Within this, an outline and a point of one concept are one store. */
const SAME_OUTLINE_M = 45;
/** Degrees of latitude that hold `SAME_OUTLINE_M` with room to spare. */
const SAME_STORE_LAT = 0.00045;

const isOutline = (row) => !row.id.startsWith('n');

/**
 * Whether two rows are one store mapped twice. In whole metres: a point's
 * five decimals place it within a metre.
 */
function sameStore(a, b) {
  if (a.company !== b.company) return false;
  const distance = Math.round(distanceMeters(a.point, b.point));
  if (distance <= SAME_STORE_M) return true;
  return (
    distance <= SAME_OUTLINE_M &&
    isOutline(a) !== isOutline(b) &&
    a.brand === b.brand
  );
}

/** How much a row says: an outline's area first, then its known fields. */
const weight = (row) =>
  (row.area != null ? 1000 : 0) +
  Object.values(row).filter((value) => value != null).length;

/** The row of a group that says most, the first of equals. */
function keeperOf(group) {
  let keeper = group[0];
  for (const row of group) if (weight(row) > weight(keeper)) keeper = row;
  return keeper;
}

/**
 * One store from rows that are the same store: the keeper, with what it
 * lacks from the others, the most telling name and a concept as brand.
 */
function mergeGroup(keeper, group) {
  const company = companyById(keeper.company);
  const others = group.filter((row) => row !== keeper);
  const merged = { ...keeper };
  for (const other of others)
    for (const [key, value] of Object.entries(other)) {
      // The date hours were checked on belongs to those hours only.
      if (value == null || merged[key] != null || key === 'checked') continue;
      merged[key] = value;
      if (key !== 'hours') continue;
      if (other.checked != null) merged.checked = other.checked;
      else delete merged.checked;
    }
  const isConcept = (brand) =>
    company.concepts.some((concept) => concept.brand === brand);
  if (!isConcept(keeper.brand))
    merged.brand =
      others.find((row) => isConcept(row.brand))?.brand ?? keeper.brand;
  // A name that is more than the chain's or the concept's, then the longest.
  const plain = new Set(
    [
      company.name,
      ...company.names,
      ...company.concepts.map((concept) => concept.brand),
      ...group.map((row) => row.brand),
    ].map((value) => String(value).toLowerCase()),
  );
  const told = group.filter((row) => !plain.has(row.name.toLowerCase()));
  const named = told.length ? told : group;
  let best = named.includes(keeper) ? keeper : named[0];
  for (const row of named) if (row.name.length > best.name.length) best = row;
  merged.name = best.name;
  return merged;
}

/** The rows with every store that is mapped twice merged into one. */
function mergeDuplicates(rows) {
  const latitude = Float64Array.from(rows, (row) => row.point[1]);
  const byLatitude = Uint32Array.from(rows, (_, index) => index).sort(
    (a, b) => latitude[a] - latitude[b],
  );
  const parent = Uint32Array.from(byLatitude).sort();
  const find = (index) => {
    while (parent[index] !== index)
      index = parent[index] = parent[parent[index]];
    return index;
  };
  for (let i = 0; i < byLatitude.length; i++) {
    const a = byLatitude[i];
    for (let j = i + 1; j < byLatitude.length; j++) {
      const b = byLatitude[j];
      if (latitude[b] - latitude[a] > SAME_STORE_LAT) break;
      if (sameStore(rows[a], rows[b])) parent[find(b)] = find(a);
    }
  }
  const groups = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    if (root === index) return;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  });
  if (!groups.size) return rows;
  const merged = new Map();
  const dropped = new Set();
  let again = false;
  for (const [root, indexes] of groups) {
    // In the order given, which decides ties.
    const group = [root, ...indexes].sort((a, b) => a - b).map((i) => rows[i]);
    const keeper = keeperOf(group);
    const store = mergeGroup(keeper, group);
    merged.set(keeper, store);
    for (const row of group) if (row !== keeper) dropped.add(row);
    // With a new concept the store may be the twin of one more outline or point.
    again ||= store.brand !== keeper.brand;
  }
  const stores = rows
    .filter((row) => !dropped.has(row))
    .map((row) => merged.get(row) ?? row);
  return again ? mergeDuplicates(stores) : stores;
}

/**
 * Stores as the layer shows them, from rows of this or an earlier snapshot:
 * former companies' stores under the company they are now, no agents, each
 * pharmacy under the chain it is named after, links to the company's own
 * domains only, and a store that is mapped twice once. Returns new rows in
 * the order given; tidying tidy rows changes nothing.
 */
export function tidyStores(stores) {
  if (!Array.isArray(stores)) throw new Error('Malformed store collection');
  const rows = [];
  for (const store of stores) {
    const former = FORMER_COMPANIES.get(store.company);
    const tagged = companyById(former ?? store.company);
    if (!tagged || AGENT.test(store.name)) continue;
    const row = { ...store, company: tagged.id };
    if (former) row.brand = brandOf(tagged, row.brand, row.name);
    const company = pharmacyChain(tagged, row.name);
    if (company !== tagged) {
      row.company = company.id;
      row.brand = company.name;
    }
    const website = chainWebsite(company, row.website);
    if (website) row.website = website;
    else if ('website' in row) delete row.website;
    rows.push(row);
  }
  return mergeDuplicates(rows);
}

/**
 * Every store of the given elements, once each and tidied, sorted by company
 * and name.
 */
export function normalizeStores(elements) {
  if (!Array.isArray(elements)) throw new Error('Malformed store collection');
  const seen = new Set();
  const order = (row) => COMPANIES.findIndex((c) => c.id === row.company);
  return tidyStores(
    elements
      .map(normalizeStore)
      .filter((row) => row && !seen.has(row.id) && seen.add(row.id)),
  ).sort(
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
