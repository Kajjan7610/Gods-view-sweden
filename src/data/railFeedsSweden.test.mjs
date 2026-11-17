// Swedish fork: Trafikverket's trains in the Rail layer. The service
// categories come from what Trafikverket publishes with each station call
// (product, information owner, the two ends of the run and their country);
// coverage is Sweden's three circles, as for the Transit feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_ENABLED_FEEDS,
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
  publicRailCatalog,
  railFeedsInRange,
} from './railFeeds.js';
import { getTransitFeed } from './transitFeeds.js';

const feed = getRegisteredRailFeed('trafikverket-trains');
const category = (record) =>
  classifyTrain(feed, '541', { tripId: '541-20261117', record })?.category ??
  null;

test('the feed is on, CC0 and credited like the Transit entry', () => {
  assert.ok(getRailFeed('trafikverket-trains'), 'pollable');
  assert.ok(RAIL_ENABLED_FEEDS.includes(feed));
  const transit = getTransitFeed('trafikverket-trains');
  for (const key of ['license', 'licenseUrl', 'attribution', 'url', 'region'])
    assert.equal(feed[key], transit[key], key);
  assert.equal(feed.license, 'CC0 1.0');
  assert.equal(feed.defaultEnabled, true);
  assert.equal(feed.terms.quote, transit.terms.quote);
  assert.match(feed.terms.note, /^The same feed the Transit layer polls/);
  assert.equal(feed.requiresKey, transit.requiresKey);
  assert.deepEqual(feed.coverage, transit.coverage);
  assert.equal(feed.format, 'trafikverket-trainposition');
});

test('products: commuter local, regional trains regional, long distance national', () => {
  for (const product of [
    'Pendeltåg',
    'Östgötapendeln',
    'Pågatåg',
    'Pågatåg Express',
    'Upptåget',
    'Arlanda Express',
  ])
    assert.equal(category({ product }), 'local', product);
  for (const product of [
    'Mälartåg',
    'Regional',
    'SJ Regional',
    'Regionaltåg',
    'Krösatåg',
    'Öresundståg',
    'Västtåg',
    'Norrtåg',
    'Tåg i Bergslagen',
    'Värmlandstrafik',
  ])
    assert.equal(category({ product }), 'regional', product);
  for (const product of [
    'SJ Snabbtåg',
    'SJ InterCity',
    'SJ Nattåg',
    'Nattåg',
    'MTRX',
    'Snälltåget',
  ])
    assert.equal(category({ product }), 'national', product);
});

test('a run that ends abroad is international, whatever the product', () => {
  for (const product of ['SJ Snabbtåg', 'Öresundståg', 'Nattåg', null])
    assert.equal(category({ product, abroad: true }), 'international');
  assert.equal(category({ product: 'Öresundståg', abroad: false }), 'regional');
});

test('without a product the owner decides; anything unknown is national', () => {
  assert.equal(category({ operator: 'SL' }), 'local');
  assert.equal(category({ operator: 'Västtrafik' }), 'regional');
  assert.equal(category({ operator: 'SJ' }), 'national');
  // The product is read first.
  assert.equal(category({ product: 'Pendeltåg', operator: 'SJ' }), 'local');
  // A train with no call yet, a freight train: on the national network.
  for (const record of [
    {},
    { product: 'Godståg' },
    { operator: 'Green Cargo' },
    undefined,
  ])
    assert.equal(category(record), 'national', JSON.stringify(record));
  // Every answer is a train on rails: none is dropped.
  assert.deepEqual(classifyTrain(feed, null), {
    category: 'national',
    mode: 'rail',
  });
});

test('Sweden is covered end to end and its neighbours are not', () => {
  const covers = (lat, lon, feeds) =>
    railFeedsInRange(lat, lon, 0, feeds).some(
      (entry) => entry.id === 'trafikverket-trains',
    );
  const catalog = publicRailCatalog({ keyConfigured: () => true });
  for (const feeds of [RAIL_ENABLED_FEEDS, catalog]) {
    for (const [name, lat, lon] of [
      ['Trelleborg', 55.375, 13.157],
      ['Göteborg', 57.71, 11.97],
      ['Stockholm', 59.33, 18.07],
      ['Östersund', 63.18, 14.64],
      ['Kiruna', 67.85, 20.22],
      ['Riksgränsen', 68.43, 18.13],
      ['Haparanda', 65.84, 24.14],
    ])
      assert.ok(covers(lat, lon, feeds), name);
    for (const [name, lat, lon] of [
      ['Oslo', 59.91, 10.75],
      ['Helsinki', 60.17, 24.94],
      ['Trondheim', 63.43, 10.4],
    ])
      assert.equal(covers(lat, lon, feeds), false, name);
  }
  // Hysteresis slack widens each circle.
  assert.ok(
    railFeedsInRange(59.91, 10.75, 120, RAIL_ENABLED_FEEDS).some(
      (entry) => entry.id === 'trafikverket-trains',
    ),
  );
});

test('the catalog lists the feed only once its key is set', () => {
  const ids = (options) => publicRailCatalog(options).map((entry) => entry.id);
  assert.ok(ids().includes('trafikverket-trains'), 'no filter given');
  assert.ok(
    !ids({ keyConfigured: () => false }).includes('trafikverket-trains'),
  );
  assert.ok(ids({ keyConfigured: () => false }).includes('mbta-rail'));
  assert.ok(
    ids({ keyConfigured: (name) => name === 'TRAFIKVERKET_API_KEY' }).includes(
      'trafikverket-trains',
    ),
  );
  // Only a feed with circles of its own carries them in the catalog.
  const entry = (id) => publicRailCatalog().find((row) => row.id === id);
  assert.equal(entry('mbta-rail').coverage, undefined);
  assert.equal(entry('trafikverket-trains').coverage.length, 3);
  assert.equal(entry('trafikverket-trains').requiresKey, undefined);
});
