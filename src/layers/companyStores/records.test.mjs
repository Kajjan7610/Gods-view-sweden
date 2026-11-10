import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPANIES,
  canonicalBrand,
  chainWebsite,
  companyById,
  companyByName,
  distanceMeters,
  normalizeStore,
  normalizeStores,
  storeAddress,
  storeColor,
  storeCounts,
  storeWebsite,
  tidyStores,
  outlineArea,
} from './records.js';
import {
  buildStoreCard,
  companyLine,
  formatDistance,
  storeNeighbours,
} from './cards.js';

const node = (id, tags, lat = 59.33, lon = 18.06) => ({
  type: 'node',
  id,
  lat,
  lon,
  tags,
});

test('a store keeps its company, concept, place, address and hours', () => {
  const row = normalizeStore(
    node(7, {
      shop: 'supermarket',
      brand: 'ICA Nära',
      'brand:wikidata': 'Q1663776',
      name: 'ICA Nära Bagarmossen',
      'addr:street': 'Lagaholmsvägen',
      'addr:housenumber': '1',
      'addr:postcode': '128 47',
      'addr:city': 'Bagarmossen',
      opening_hours: 'Mo-Su 07:00-22:00',
    }),
  );
  assert.deepEqual(row, {
    id: 'n7',
    company: 'ica',
    brand: 'ICA Nära',
    name: 'ICA Nära Bagarmossen',
    point: [18.06, 59.33],
    address: 'Lagaholmsvägen 1, 128 47 Bagarmossen',
    hours: 'Mo-Su 07:00-22:00',
  });
  assert.equal(storeColor(row), '#ffb3b5');
});

test('only shops of known companies inside the box are kept', () => {
  const ica = { 'brand:wikidata': 'Q1663776', brand: 'ICA' };
  assert.equal(normalizeStore(node(1, { ...ica, amenity: 'atm' })), null);
  assert.equal(
    normalizeStore(node(2, { ...ica, building: 'warehouse' })),
    null,
  );
  assert.equal(
    normalizeStore(node(3, { shop: 'supermarket', 'brand:wikidata': 'Q1' })),
    null,
  );
  assert.equal(
    normalizeStore(node(4, { ...ica, shop: 'supermarket' }, 48.8, 2.3)),
    null,
  );
  const way = normalizeStore({
    type: 'way',
    id: 9,
    center: { lat: 57.7, lon: 11.97 },
    tags: { shop: 'alcohol', 'brand:wikidata': 'Q1476113' },
  });
  assert.equal(way.id, 'w9');
  assert.equal(way.company, 'systembolaget');
  assert.equal(way.name, 'Systembolaget');
});

test('the collection drops repeats, sorts by company and counts concepts', () => {
  const rows = normalizeStores([
    node(5, {
      shop: 'supermarket',
      brand: 'Willys',
      'brand:wikidata': 'Q10720214',
      name: 'Willys B',
    }),
    node(6, {
      shop: 'supermarket',
      brand: 'ICA Kvantum',
      'brand:wikidata': 'Q1663776',
      name: 'ICA Kvantum A',
    }),
    node(6, {
      shop: 'supermarket',
      brand: 'ICA Kvantum',
      'brand:wikidata': 'Q1663776',
      name: 'ICA Kvantum A',
    }),
    node(
      8,
      {
        shop: 'supermarket',
        brand: 'Hemköp',
        'brand:wikidata': 'Q10521746',
        name: 'Hemköp A',
      },
      59.4,
      18.1,
    ),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['n6', 'n8', 'n5'],
  );
  assert.deepEqual(storeCounts(rows), {
    ica: { total: 1, brands: { 'ICA Kvantum': 1 } },
    axfood: { total: 2, brands: { Hemköp: 1, Willys: 1 } },
  });
  assert.throws(() => normalizeStores(null));
});

test('addresses join what is tagged and every company has a colour', () => {
  assert.equal(storeAddress({ 'addr:city': 'Kiruna' }), 'Kiruna');
  assert.equal(storeAddress({}), null);
  for (const company of COMPANIES)
    assert.match(company.color, /^#[0-9a-f]{6}$/i);
});

test('the card names the store, its address, hours and company', () => {
  const card = buildStoreCard(
    {
      id: 'n6',
      company: 'ica',
      brand: 'ICA Kvantum',
      name: 'ICA Kvantum Mitt i City',
      point: [15, 60],
      address: 'Storgatan 1, Falun',
      hours: 'Mo-Su 08:00-21:00',
    },
    {
      ica: {
        legalName: 'ICA AB',
        orgNumber: '556582-1559',
        headOffice: 'Solna',
      },
    },
  );
  assert.equal(card.title, 'ICA KVANTUM MITT I CITY');
  assert.ok(card.details.includes('Storgatan 1, Falun'));
  assert.ok(card.details.some((line) => line.includes('556582-1559')));
  assert.ok(card.details.some((line) => line.includes('ODbL')));
  assert.equal(
    companyLine(COMPANIES[0], undefined),
    'ICA · part of ICA Gruppen',
  );
});

test('concept spellings are read as the company’s own concepts', () => {
  const ica = COMPANIES[0];
  assert.equal(canonicalBrand(ica, 'Ica Nära'), 'ICA Nära');
  assert.equal(canonicalBrand(ica, 'ICA Nära;PostNord'), 'ICA Nära');
  assert.equal(canonicalBrand(ica, 'ICA Maxi'), 'Maxi ICA Stormarknad');
  assert.equal(canonicalBrand(ica, 'ICA ToGo'), 'ICA ToGo');
  assert.equal(canonicalBrand(ica, undefined), 'ICA');
});

test('untagged and older-tagged stores find their company and concept', () => {
  const coop = (tags) =>
    normalizeStore(node(20, { shop: 'supermarket', ...tags }));
  assert.equal(coop({ name: 'Stora Coop Bromma' }).brand, 'Stora Coop');
  assert.equal(coop({ name: 'Stora Coop Bromma' }).company, 'coop');
  assert.equal(
    coop({ brand: 'Coop (Sweden)', 'brand:wikidata': 'Q15229319' }).brand,
    'Coop',
  );
  assert.equal(coop({ name: 'X:-tra Rinkeby' }).brand, 'X:-tra');
  assert.equal(coop({ brand: 'Coop Konsum', name: 'Konsum' }).brand, 'Coop');
  assert.equal(coop({ name: 'ICA Nära Ankaret', brand: 'ICA' }).company, 'ica');
  assert.equal(
    coop({ name: 'ICA Nära Ankaret', brand: 'ICA' }).brand,
    'ICA Nära',
  );
  // A shop tagged with another brand item is not taken by its name.
  assert.equal(
    coop({ name: 'Coop Prix Moss', 'brand:wikidata': 'Q5167705' }),
    null,
  );
  assert.equal(coop({ name: 'Coopers bageri' }), null);
});

test('a store keeps its web page, phone, access, parcel service and size', () => {
  // A 60 m by 40 m outline.
  const dLat = 40 / 111195;
  const dLon = 60 / (111195 * Math.cos((59.33 * Math.PI) / 180));
  const geometry = [
    { lat: 59.33, lon: 18.06 },
    { lat: 59.33, lon: 18.06 + dLon },
    { lat: 59.33 + dLat, lon: 18.06 + dLon },
    { lat: 59.33 + dLat, lon: 18.06 },
    { lat: 59.33, lon: 18.06 },
  ];
  assert.equal(outlineArea(geometry), 2400);
  assert.equal(outlineArea(geometry.slice(0, 2)), null);
  const row = normalizeStore({
    type: 'way',
    id: 11,
    bounds: { minlat: 59.33, minlon: 18.06, maxlat: 59.34, maxlon: 18.07 },
    geometry,
    tags: {
      shop: 'supermarket',
      'brand:wikidata': 'Q10720214',
      brand: 'Willys',
      website: 'https://www.willys.se/butik/2110',
      'contact:phone': '+46 8 123 45 67',
      wheelchair: 'limited',
      post_office: 'post_partner',
      'post_office:brand': 'PostNord',
      check_date: '2026-05-01',
    },
  });
  assert.deepEqual(row.point, [18.065, 59.335]);
  assert.equal(row.website, 'https://www.willys.se/butik/2110');
  assert.equal(row.phone, '+46 8 123 45 67');
  assert.equal(row.wheelchair, 'limited');
  assert.equal(row.post, 'PostNord');
  assert.equal(row.area, 2400);
  assert.equal(row.checked, '2026-05-01');
  assert.equal(storeWebsite({ website: 'javascript:alert(1)' }), null);
  assert.equal(storeWebsite({ website: 'www.ica.se' }), null);
});

test('the card adds open now, size, people, stop, nearby chains and a link', () => {
  const row = {
    id: 'n1',
    company: 'ica',
    brand: 'ICA Nära',
    name: 'ICA Nära Bagarmossen',
    point: [18.13, 59.276],
    hours: 'Mo-Su 07:00-22:00',
    website: 'https://www.ica.se/butiker/nara/stockholm/ica-nara-bagarmossen/',
    area: 850,
    wheelchair: 'yes',
    post: '',
    population: 21450,
    stop: { name: 'Bagarmossen', distance: 120 },
  };
  const stores = [
    row,
    { id: 'n2', company: 'axfood', brand: 'Willys', point: [18.15, 59.276] },
    { id: 'n3', company: 'lidl', brand: 'Lidl', point: [18.3, 59.276] },
    { id: 'n4', company: 'ica', brand: 'ICA Kvantum', point: [18.131, 59.276] },
  ];
  const card = buildStoreCard(
    row,
    {},
    {
      stores,
      populationYear: 2025,
      linkable: true,
      now: new Date('2026-11-09T10:00:00Z'),
    },
  );
  const text = card.details.join('\n');
  assert.match(text, /Open now · closes 22:00/);
  assert.match(text, /850 m² mapped/);
  assert.match(text, /Wheelchair accessible · Parcel service/);
  assert.match(text, /21,450 people live within 2 km \(SCB 2025\)/);
  assert.match(text, /Nearest stop: Bagarmossen, 120 m/);
  assert.match(text, /Nearest other chains: Willys 1\.1 km · Lidl 9\.7 km/);
  assert.match(text, /2 chain stores within 5 km/);
  assert.equal(card.interactive, true);
  // Without a way to open the page the card still takes its own clicks.
  assert.equal(buildStoreCard(row).interactive, true);
  const { nearest, within } = storeNeighbours(row, stores);
  assert.deepEqual(
    nearest.map((entry) => entry.store.id),
    ['n2', 'n3'],
  );
  assert.equal(within, 2);
  assert.equal(formatDistance(4), '10 m');
  assert.ok(distanceMeters([18, 59], [18, 60]) > 111_000);
});

test('pharmacy chains keep pharmacies, not shops, and name their owner', () => {
  const place = (tags) => normalizeStore(node(30, tags));
  const hjartat = place({
    amenity: 'pharmacy',
    brand: 'Apotek Hjärtat',
    'brand:wikidata': 'Q10416114',
    name: 'Apotek Hjärtat Falun',
  });
  assert.equal(hjartat.company, 'apotek-hjartat');
  assert.equal(hjartat.brand, 'Apotek Hjärtat');
  // Untagged, by name; the old Lloyds name still finds DOZ Apotek.
  assert.equal(
    place({ amenity: 'pharmacy', name: 'Apoteket Kronan' }).company,
    'apoteket',
  );
  assert.equal(
    place({ amenity: 'pharmacy', name: 'Lloyds Apotek Borlänge' }).company,
    'doz-apotek',
  );
  // A pharmacy brand on something else, or a shop item at a pharmacy, is dropped.
  assert.equal(
    place({ shop: 'chemist', 'brand:wikidata': 'Q10416114' }),
    null,
  );
  assert.equal(
    place({ amenity: 'pharmacy', 'brand:wikidata': 'Q1663776' }),
    null,
  );
  const company = (id) => COMPANIES.find((entry) => entry.id === id);
  assert.equal(
    companyLine(company('apotek-hjartat'), undefined),
    'Apotek Hjärtat · part of ICA Gruppen',
  );
  assert.equal(
    companyLine(company('apoteket'), { legalName: 'Apoteket AB' }),
    'Apoteket AB · state-owned',
  );
});

test('nine companies remain, with City Gross and Apoteksgruppen folded in', () => {
  assert.deepEqual(
    COMPANIES.map((company) => company.id),
    [
      'ica',
      'coop',
      'axfood',
      'lidl',
      'systembolaget',
      'apotek-hjartat',
      'apoteket',
      'kronans-apotek',
      'doz-apotek',
    ],
  );
  const gross = normalizeStore(
    node(40, {
      shop: 'supermarket',
      brand: 'City Gross',
      'brand:wikidata': 'Q10453555',
      name: 'City Gross Norrköping',
    }),
  );
  assert.equal(gross.company, 'axfood');
  assert.equal(gross.brand, 'City Gross');
  assert.equal(storeColor(gross), '#8e24aa');
  assert.equal(
    normalizeStore(node(41, { shop: 'supermarket', name: 'City Gross Växjö' }))
      .company,
    'axfood',
  );
  const group = normalizeStore(
    node(42, {
      amenity: 'pharmacy',
      brand: 'Apoteksgruppen',
      'brand:wikidata': 'Q10416129',
      name: 'Apoteksgruppen Tierp',
    }),
  );
  assert.equal(group.company, 'kronans-apotek');
  assert.equal(group.brand, 'Kronans Apotek');
  for (const company of COMPANIES) {
    assert.ok(company.domains.length, company.id);
    assert.ok(Object.isFrozen(company.domains));
  }
});

test('a link is kept only when it leads to the company’s own pages', () => {
  const ica = companyById('ica');
  assert.equal(
    chainWebsite(ica, 'https://www.ica.se/butiker/1/'),
    'https://www.ica.se/butiker/1/',
  );
  assert.equal(chainWebsite(ica, 'https://ica.se'), 'https://ica.se');
  // Read as https, and otherwise as written.
  assert.equal(
    chainWebsite(ica, 'http://www.ica.se/Butiker/?a=1#b'),
    'https://www.ica.se/Butiker/?a=1#b',
  );
  assert.equal(chainWebsite(ica, 'HTTP://WWW.ICA.SE/x'), 'https://WWW.ICA.SE/x');
  assert.equal(
    chainWebsite(companyById('coop'), 'https://www.coopvarmland.se/'),
    'https://www.coopvarmland.se/',
  );
  for (const url of [
    'https://www.icabostrom.se/',
    'https://ica.se.example.com/',
    'https://notica.se/',
    'https://www.facebook.com/ica',
    'https://www.ica.se@example.com/',
    'https://user:secret@www.ica.se/',
    'https://www.willys.se/',
    'javascript:alert(1)',
    'www.ica.se',
    'https://www.ica.se/a b',
    '',
    null,
    undefined,
    42,
  ])
    assert.equal(chainWebsite(ica, url), null, String(url));
  assert.equal(chainWebsite(null, 'https://www.ica.se/'), null);
  const shop = (website) =>
    normalizeStore(
      node(50, { shop: 'supermarket', 'brand:wikidata': 'Q1663776', website }),
    );
  assert.equal(shop('http://www.ica.se/x').website, 'https://www.ica.se/x');
  assert.equal('website' in shop('https://www.maxisolna.se/'), false);
});

test('a pharmacy named after another chain is that chain’s', () => {
  const tagged = (name, item = 'Q1785637') =>
    normalizeStore(
      node(60, {
        amenity: 'pharmacy',
        brand: 'Apoteket',
        'brand:wikidata': item,
        name,
      }),
    );
  for (const name of ['Apotek Hjärtat Broby', 'Apoteket Hjärtat ICA']) {
    assert.equal(tagged(name).company, 'apotek-hjartat', name);
    assert.equal(tagged(name).brand, 'Apotek Hjärtat', name);
    assert.equal(tagged(name).name, name);
  }
  assert.equal(tagged('Kronans Apotek Torget').company, 'kronans-apotek');
  // "Apoteket" alone is the pharmacy, any pharmacy: it moves none.
  assert.equal(tagged('Apoteket Kronan').company, 'apoteket');
  assert.equal(tagged('Apoteket', 'Q10549422').company, 'kronans-apotek');
  assert.equal(
    tagged('Apoteket Storgatan', 'Q10416114').company,
    'apotek-hjartat',
  );
  assert.equal(
    tagged('Lloyds Apotek Borlänge', 'Q10475311').company,
    'doz-apotek',
  );
  assert.equal(tagged('Apotek Hjärtats vänner').company, 'apoteket');
  // The longest name a place starts with decides, not the order of the list.
  assert.equal(
    companyByName({ name: 'Apoteket Hjärtat Nacka' }).id,
    'apotek-hjartat',
  );
  assert.equal(companyByName({ name: 'Apoteket Nacka' }).id, 'apoteket');
  assert.equal(companyByName({ name: 'Stora Coop Bromma' }).id, 'coop');
  assert.equal(
    companyByName({ name: 'Coop', 'brand:wikidata': 'Q5167705' }),
    null,
  );
  // A shop is not a pharmacy, whatever it is called.
  assert.equal(
    normalizeStore(
      node(61, {
        shop: 'supermarket',
        'brand:wikidata': 'Q1663776',
        name: 'Apotek Hjärtat',
      }),
    ).company,
    'ica',
  );
});

test('an agent in someone else’s shop is not a store', () => {
  const place = (tags) => normalizeStore(node(70, tags));
  assert.equal(
    place({
      shop: 'alcohol',
      'brand:wikidata': 'Q1476113',
      name: 'Systembolaget ombud',
    }),
    null,
  );
  assert.equal(
    place({
      amenity: 'pharmacy',
      'brand:wikidata': 'Q1785637',
      name: 'Apoteket Ombud Storuman',
    }),
    null,
  );
  assert.equal(
    place({
      shop: 'supermarket',
      'brand:wikidata': 'Q1663776',
      name: 'ICA Nära Ombudsgatan',
    }).name,
    'ICA Nära Ombudsgatan',
  );
});

/** A row as a snapshot holds it, `north` metres north of the first. */
const store = (id, extra = {}, north = 0) => ({
  id,
  company: 'ica',
  brand: 'ICA Nära',
  name: 'ICA Nära',
  point: [18.06, Math.round((59.33 + north * 0.000009) * 1e5) / 1e5],
  address: null,
  hours: null,
  ...extra,
});
const ids = (rows) => rows.map((row) => row.id);

test('tidy rows are of today’s companies, with their own links and no agents', () => {
  const input = [
    store('n1', {
      company: 'city-gross',
      brand: 'City Gross',
      name: 'City Gross Kalmar',
      website: 'http://www.citygross.se/butiker/kalmar',
    }),
    store(
      'n2',
      {
        company: 'apoteksgruppen',
        brand: 'Apoteksgruppen',
        name: 'Apoteksgruppen Tierp',
        website: 'https://www.apoteksgruppen.se/apotek/tierp/',
      },
      1000,
    ),
    store(
      'n3',
      {
        company: 'apoteket',
        brand: 'Apoteket',
        name: 'Apoteket Hjärtat ICA',
        website: 'https://www.apoteket.se/',
      },
      2000,
    ),
    store('n4', { company: 'apoteket', name: 'Apoteket ombud' }, 3000),
    store('n5', { company: 'netto', name: 'Netto' }, 4000),
    store('n6', { website: 'https://www.icabostrom.se/' }, 5000),
    store('n7', { website: 'https://www.ica.se/butiker/7/' }, 6000),
  ];
  const before = JSON.stringify(input);
  const rows = tidyStores(input);
  assert.equal(JSON.stringify(input), before, 'the rows given are untouched');
  assert.deepEqual(ids(rows), ['n1', 'n2', 'n3', 'n6', 'n7']);
  assert.ok(rows.every((row) => !input.includes(row)));
  const [gross, group, hjartat, off, own] = rows;
  assert.equal(gross.company, 'axfood');
  assert.equal(gross.brand, 'City Gross');
  assert.equal(gross.website, 'https://www.citygross.se/butiker/kalmar');
  assert.equal(group.company, 'kronans-apotek');
  assert.equal(group.brand, 'Kronans Apotek');
  assert.equal(group.website, 'https://www.apoteksgruppen.se/apotek/tierp/');
  assert.equal(hjartat.company, 'apotek-hjartat');
  assert.equal(hjartat.brand, 'Apotek Hjärtat');
  // The link was Apoteket's, not the chain's the pharmacy turned out to be.
  assert.equal('website' in hjartat, false);
  assert.equal('website' in off, false);
  assert.equal(own.website, 'https://www.ica.se/butiker/7/');
  assert.deepEqual(tidyStores(rows), rows, 'tidy rows stay as they are');
  assert.deepEqual(tidyStores([]), []);
  assert.throws(() => tidyStores(null));
  assert.throws(() => tidyStores({ stores: [] }));
});

test('a store mapped twice is one store, and two stores stay two', () => {
  const pair = (a, b) => ids(tidyStores([a, b]));
  // Within 20 m: one store, whatever the two are.
  assert.deepEqual(pair(store('n1'), store('n2', {}, 17)), ['n1']);
  assert.deepEqual(
    pair(store('n1'), store('n2', { brand: 'ICA Kvantum' }, 17)),
    ['n1'],
  );
  assert.deepEqual(pair(store('n1'), store('n2', {}, 23)), ['n1', 'n2']);
  // Further apart, up to 45 m: only an outline and a point of one concept.
  assert.deepEqual(pair(store('n1'), store('n2', {}, 30)), ['n1', 'n2']);
  assert.deepEqual(pair(store('w1'), store('w2', {}, 30)), ['w1', 'w2']);
  assert.deepEqual(pair(store('w1'), store('n2', {}, 30)), ['w1']);
  assert.deepEqual(pair(store('n1'), store('r2', {}, 44)), ['n1']);
  assert.deepEqual(
    pair(store('w1'), store('n2', { brand: 'ICA Kvantum' }, 30)),
    ['w1', 'n2'],
  );
  assert.deepEqual(pair(store('w1'), store('n2', {}, 47)), ['w1', 'n2']);
  // Another company's store is never the same store.
  assert.deepEqual(
    pair(store('n1'), store('n2', { company: 'coop', brand: 'Coop' })),
    ['n1', 'n2'],
  );
  // Three in a row, each within reach of the next, are one.
  assert.deepEqual(
    ids(tidyStores([store('n1'), store('n2', {}, 17), store('n3', {}, 34)])),
    ['n1'],
  );
  // The merged store stands where its fullest row stood; the rest keep their order.
  assert.deepEqual(
    ids(
      tidyStores([
        store('n9', {}, 900),
        store('n1'),
        store('n5', {}, 500),
        store('w2', { area: 500 }, 30),
        store('n3', {}, 300),
      ]),
    ),
    ['n9', 'n5', 'w2', 'n3'],
  );
});

test('the merged store keeps the fullest row and takes what it lacks', () => {
  const merged = (...rows) => {
    const tidy = tidyStores(rows);
    assert.equal(tidy.length, 1);
    return tidy[0];
  };
  // The outline with an area first, though the point says more.
  const outline = store('w1', { area: 900 });
  const point = store(
    'n2',
    {
      name: 'ICA Nära Lundmans',
      address: 'Storgatan 1',
      hours: 'Mo-Su 08:00-21:00',
      checked: '2026-05-01',
      phone: '+46 8 123',
      website: 'https://www.ica.se/butiker/2/',
    },
    10,
  );
  assert.deepEqual(merged(point, outline), {
    ...outline,
    name: 'ICA Nära Lundmans',
    address: 'Storgatan 1',
    hours: 'Mo-Su 08:00-21:00',
    checked: '2026-05-01',
    phone: '+46 8 123',
    website: 'https://www.ica.se/butiker/2/',
  });
  // Else the row with most known fields, and of equals the first.
  assert.equal(merged(store('n1'), store('n2', { phone: '1' }, 5)).id, 'n2');
  assert.equal(merged(store('n1'), store('n2', {}, 5)).id, 'n1');
  assert.equal(
    merged(store('n1', { phone: '1' }), store('n2', { phone: '2' }, 5)).phone,
    '1',
  );
  // The date belongs to the hours it was checked with.
  const dated = merged(
    store('n1', { hours: 'Mo-Su 08:00-21:00', phone: '1' }),
    store('n2', { hours: 'Mo-Su 07:00-22:00', checked: '2026-05-01' }, 5),
  );
  assert.equal(dated.hours, 'Mo-Su 08:00-21:00');
  assert.equal('checked' in dated, false);
  const undated = merged(
    store('w1', { area: 900, checked: '2026-05-01' }),
    store('n2', { hours: 'Mo-Su 07:00-22:00' }, 5),
  );
  assert.equal(undated.hours, 'Mo-Su 07:00-22:00');
  assert.equal('checked' in undated, false);
  // A name that says more than the chain or the concept, then the longest.
  assert.equal(
    merged(
      store('n1', { name: 'ICA Supermarket', phone: '1' }),
      store('n2', { name: 'Husby' }, 5),
    ).name,
    'Husby',
  );
  assert.equal(
    merged(
      store('n1', { name: 'ICA Nära Lund', phone: '1' }),
      store('n2', { name: 'ICA Nära Lundmans' }, 5),
    ).name,
    'ICA Nära Lundmans',
  );
  assert.equal(
    merged(store('n1', { name: 'Abc' }), store('n2', { name: 'Xyz' }, 5)).name,
    'Abc',
  );
  // A concept from the other row, when the keeper has none.
  assert.equal(
    merged(store('w1', { area: 900, brand: 'ICA' }), store('n2', {}, 5)).brand,
    'ICA Nära',
  );
  assert.equal(
    merged(store('w1', { area: 900, brand: 'ICA Kvantum' }), store('n2', {}, 5))
      .brand,
    'ICA Kvantum',
  );
});

test('tidying tidy stores changes nothing, also after a merge names a concept', () => {
  // The outline is the first point's twin, and with its concept the second's.
  const rows = tidyStores([
    store('w1', { area: 900, brand: 'ICA' }),
    store('n2', {}, 15),
    store('n3', {}, -30),
    store('n4', { company: 'coop', brand: 'Coop', name: 'Coop' }, -30),
  ]);
  assert.deepEqual(ids(rows), ['w1', 'n4']);
  assert.equal(rows[0].brand, 'ICA Nära');
  assert.deepEqual(tidyStores(rows), rows);
});

test('the collection merges a store mapped as an outline and as a point', () => {
  const tags = {
    shop: 'supermarket',
    brand: 'Lidl',
    'brand:wikidata': 'Q151954',
  };
  const rows = normalizeStores([
    node(80, { ...tags, opening_hours: 'Mo-Su 08:00-21:00' }, 59.3303, 18.06),
    { type: 'way', id: 81, center: { lat: 59.33, lon: 18.06 }, tags },
    node(82, tags, 59.4, 18.06),
  ]);
  assert.deepEqual(ids(rows), ['n80', 'n82']);
  assert.equal(rows[0].hours, 'Mo-Su 08:00-21:00');
});
