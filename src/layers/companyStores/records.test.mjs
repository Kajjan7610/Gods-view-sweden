import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPANIES,
  canonicalBrand,
  normalizeStore,
  normalizeStores,
  storeAddress,
  storeColor,
  storeCounts,
} from './records.js';
import { buildStoreCard, companyLine } from './cards.js';

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
    node(8, {
      shop: 'supermarket',
      brand: 'Hemköp',
      'brand:wikidata': 'Q10521746',
      name: 'Hemköp A',
    }),
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
  assert.equal(companyLine(COMPANIES[0], undefined), 'ICA');
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
