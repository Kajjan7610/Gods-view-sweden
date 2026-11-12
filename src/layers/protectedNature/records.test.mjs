import assert from 'node:assert/strict';
import test from 'node:test';
import { areasInView, skyddadNaturUrl } from './records.js';
import { areaText, buildAreaCard } from './cards.js';

const area = (i, t, lon, lat) => ({
  i,
  t,
  b: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
});
const AREAS = [
  area('np-far', 'np', 12.7, 61.5),
  area('nr-near', 'nr', 18.05, 59.3),
  area('np-near', 'np', 18.25, 59.18),
  area('kr-near', 'kr', 17.9, 59.35),
];

test('a close view gets every kind of area in it, nearest the centre first', () => {
  const { areas, wide } = areasInView(AREAS, [17.8, 59.1, 18.3, 59.5], {
    limit: 10,
    wideAboveDeg: 3,
  });
  assert.equal(wide, false);
  assert.deepEqual(
    areas.map(({ i }) => i),
    ['nr-near', 'kr-near', 'np-near'],
  );
  assert.equal(
    areasInView(AREAS, [17.8, 59.1, 18.3, 59.5], { limit: 1, wideAboveDeg: 3 })
      .areas.length,
    1,
  );
});

test('a wide view gets the national parks alone', () => {
  const { areas, wide } = areasInView(AREAS, [10, 55, 24.5, 69.2], {
    limit: 10,
    wideAboveDeg: 3,
  });
  assert.equal(wide, true);
  assert.deepEqual(areas.map(({ i }) => i).sort(), ['np-far', 'np-near']);
});

test('an area opens by its id in Skyddad natur', () => {
  assert.equal(
    skyddadNaturUrl('2002424'),
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2002424',
  );
  assert.equal(
    skyddadNaturUrl('a&b'),
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=a%26b',
  );
});

test('a card names the area, its size and age, and its source', () => {
  const fulufjallet = {
    i: '2002424',
    n: 'Fulufjället',
    t: 'np',
    y: 2002,
    k: 'Älvdalen',
    h: 38441,
    b: [12.5, 61.4, 12.9, 61.7],
  };
  const card = buildAreaCard(fulufjallet, { linkable: true });
  assert.equal(card.title, 'NATIONAL PARK · Fulufjället');
  assert.deepEqual(card.details, [
    'Älvdalen',
    '384 km² · protected since 2002',
    'Skyddad natur ↗ · click card to open',
    'Source: Naturvårdsverket',
  ]);
  assert.equal(card.accessibilityLabel, 'Open Fulufjället in Skyddad natur');
  assert.equal(card.accent, '#1b5e20');

  const plain = buildAreaCard({ i: '1', n: 'Lilla', t: 'kr', h: 12 });
  assert.equal(plain.title, 'CULTURE RESERVE · Lilla');
  assert.deepEqual(plain.details, ['12 ha', 'Source: Naturvårdsverket']);
  assert.equal(plain.accessibilityLabel, undefined);
});

test('an area under 1 000 ha is told in hectares, a larger one in km²', () => {
  assert.equal(areaText(999), '999 ha');
  assert.equal(areaText(1000), '10 km²');
  assert.equal(areaText(Number.NaN), '');
});
