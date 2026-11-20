import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BAN_REASONS,
  allYear,
  areaLink,
  areasInView,
  banPeriod,
  naturaDesignation,
  naturaYear,
  skyddadNaturUrl,
} from './records.js';
import { areaText, banPeriodText, buildAreaCard } from './cards.js';

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

test('a view between wide and close leaves out the Natura 2000 areas and bans', () => {
  const extras = [
    ...AREAS,
    area('SE0110001', 'n2k', 18.1, 59.3),
    area('tf1', 'ban', 18.2, 59.2),
  ];
  const view = (bbox) =>
    areasInView(extras, bbox, { limit: 10, wideAboveDeg: 3, closeBelowDeg: 2 });
  const middle = view([16.5, 58.5, 19, 60]);
  assert.deepEqual([middle.wide, middle.close], [false, false]);
  assert.deepEqual(middle.areas.map(({ i }) => i).sort(), [
    'kr-near',
    'np-near',
    'nr-near',
  ]);
  const close = view([17.8, 59.1, 18.3, 59.5]);
  assert.deepEqual([close.wide, close.close], [false, true]);
  assert.deepEqual(close.areas.map(({ i }) => i).sort(), [
    'SE0110001',
    'kr-near',
    'np-near',
    'nr-near',
    'tf1',
  ]);
  const wide = view([10, 55, 24.5, 69.2]);
  assert.deepEqual([wide.wide, wide.close], [true, false]);
  // Without a close bound every view short of wide is close.
  assert.equal(
    areasInView(extras, [16.5, 58.5, 19, 60], { limit: 10, wideAboveDeg: 3 })
      .close,
    true,
  );
});

test('a ban period is read from the register’s day/month dates', () => {
  assert.deepEqual(banPeriod('1/4', '31/7'), [1, 4, 31, 7]);
  assert.deepEqual(banPeriod(' 15/11 ', '1/2'), [15, 11, 1, 2]);
  for (const [from, to] of [
    ['', '31/7'],
    ['1/4', null],
    ['31/2', '1/3'],
    ['29/2', '1/3'],
    ['1/13', '1/3'],
    ['0/4', '1/5'],
    ['1-4', '31-7'],
    ['2026-04-01', '31/7'],
  ])
    assert.equal(banPeriod(from, to), null, `${from}–${to}`);
  assert.equal(allYear([1, 1, 31, 12]), true);
  assert.equal(allYear([1, 4, 31, 7]), false);
  assert.equal(allYear(undefined), false);
  assert.deepEqual(Object.values(BAN_REASONS).sort(), [
    'bird',
    'birdSeal',
    'other',
    'seal',
  ]);
  assert.equal(BAN_REASONS['Fågel och säl'], 'birdSeal');
});

test('a Natura 2000 site is told by the files it is in, and its first year', () => {
  assert.equal(naturaDesignation(true, false), 'spa');
  assert.equal(naturaDesignation(false, true), 'sci');
  assert.equal(naturaDesignation(true, true), 'spa-sci');
  assert.equal(naturaDesignation(false, false), null);
  assert.equal(naturaYear('200007', '', '200501', '199612'), 1996);
  assert.equal(naturaYear('', null, undefined), null);
});

test('a ban opens its protected area; a Natura 2000 area opens nothing', () => {
  assert.equal(
    areaLink({ i: '2002424', t: 'np' }),
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2002424',
  );
  assert.equal(
    areaLink({ i: 'tf1935789', t: 'ban', r: '2004016' }),
    'https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=2004016',
  );
  assert.equal(areaLink({ i: 'tf1', t: 'ban' }), null);
  assert.equal(areaLink({ i: 'SE0410051', t: 'n2k' }), null);
});

test('a ban card tells its reason, its period and its county', () => {
  const ban = {
    i: 'tf1935789',
    r: '2004016',
    n: 'Yttre Tärnskäret',
    t: 'ban',
    s: 'bird',
    p: [15, 4, 15, 7],
    k: 'Örebro län',
    h: 1.9,
  };
  const card = buildAreaCard(ban, { linkable: true });
  assert.equal(card.title, 'ACCESS BAN · Yttre Tärnskäret');
  assert.deepEqual(card.details, [
    'Örebro län',
    'Bird protection · No entry April 15 – July 15',
    '1.9 ha',
    'Skyddad natur ↗ · click card to open',
    'Source: Naturvårdsverket',
  ]);
  assert.equal(card.accent, '#f4511e');
  const other = buildAreaCard({ ...ban, s: 'other', p: [1, 1, 31, 12] });
  assert.equal(other.details[1], 'No entry all year');
  assert.equal(
    buildAreaCard({ ...ban, p: undefined }).details[1],
    'Bird protection',
  );
  assert.equal(banPeriodText([1, 4]), '');
});

test('a Natura 2000 card tells its directives and site code', () => {
  const card = buildAreaCard({
    i: 'SE0630068',
    n: 'Agön-Kråkön',
    t: 'n2k',
    d: 'spa-sci',
    y: 2000,
    k: 'Hudiksvall',
    h: 4622,
  });
  assert.equal(card.title, 'NATURA 2000 · Agön-Kråkön');
  assert.deepEqual(card.details, [
    'Hudiksvall',
    '46 km² · in Natura 2000 since 2000',
    'Birds and Habitats Directives (SPA/SCI) · SE0630068',
    'Source: Naturvårdsverket',
  ]);
  assert.equal(card.accessibilityLabel, undefined);
  assert.equal(card.accent, '#1e88e5');
});

test('an area under 1 000 ha is told in hectares, a larger one in km²', () => {
  assert.equal(areaText(999), '999 ha');
  assert.equal(areaText(1000), '10 km²');
  assert.equal(areaText(Number.NaN), '');
  // A skerry is never "0 ha".
  assert.equal(areaText(0), 'under 0.1 ha');
  assert.equal(areaText(0.05), 'under 0.1 ha');
  assert.equal(areaText(0.1), '0.1 ha');
});
