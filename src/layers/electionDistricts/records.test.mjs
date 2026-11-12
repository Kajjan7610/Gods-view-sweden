import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARTIES,
  TURNOUT_CLASSES,
  districtResults,
  districtsInView,
  leadingParty,
  polygonsContain,
  sweref99tmToWgs84,
  turnoutClass,
} from './records.js';
import { buildDistrictCard } from './cards.js';

test('SWEREF 99 TM turns into longitude and latitude', () => {
  // On the central meridian the longitude is exactly 15°.
  const [lon, lat] = sweref99tmToWgs84([500000, 6650000]);
  assert.equal(lon, 15);
  assert.ok(lat > 59.9 && lat < 60.1, String(lat));
  // A district in Karlshamn (Valmyndigheten's first map feature) lands in
  // Karlshamn, about 14.86° E, 56.17° N.
  const [kx, ky] = sweref99tmToWgs84([490778.33, 6227214.86]);
  assert.ok(Math.abs(kx - 14.85) < 0.05, String(kx));
  assert.ok(Math.abs(ky - 56.18) < 0.05, String(ky));
});

test('votes become shares of the votes counted, collection districts left out', () => {
  const row = (code, votes) => ({
    Valtyp: 'Riksdag',
    Valdistriktskod: code,
    Valdistriktsnamn: 'X',
    Kommunkod: '0114',
    Kommunnamn: 'Upplands Väsby',
    'Arbetarepartiet-Socialdemokraterna': String(votes[0]),
    Moderaterna: String(votes[1]),
    Sverigedemokraterna: null,
    Örebropartiet: '10',
  });
  const results = districtResults(
    [row('01140101', [600, 390]), row('011400', [5, 5])],
    [
      { Valdistriktskod: '01140101', 'Valdeltagande (%)': '0.8361' },
      { Valdistriktskod: '011400', 'Valdeltagande (%)': null },
    ],
  );
  assert.deepEqual([...results.keys()], ['01140101']);
  const district = results.get('01140101');
  assert.equal(district.votes, 1000);
  // S, M, SD, V, C, KD, MP, L, then the rest together.
  assert.deepEqual(district.shares, [600, 390, 0, 0, 0, 0, 0, 0, 10]);
  assert.equal(district.turnout, 836);
  assert.equal(leadingParty(district.shares), PARTIES[0]);
  assert.equal(leadingParty([]), null);
});

test('turnout classes cover every turnout', () => {
  assert.equal(turnoutClass(699).id, 'below-70');
  assert.equal(turnoutClass(700).id, '70-80');
  assert.equal(turnoutClass(899).id, '85-90');
  assert.equal(turnoutClass(950).id, 'above-90');
  assert.equal(turnoutClass(null), null);
  assert.equal(TURNOUT_CLASSES.at(-1).max, Infinity);
});

test('a view gets the districts in it, nearest its centre first, at most a limit', () => {
  const district = (c, lon, lat) => ({
    c,
    b: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
  });
  const districts = [
    district('far', 18.5, 59.5),
    district('near', 18.05, 59.33),
    district('outside', 12, 57.7),
    district('mid', 18.2, 59.4),
  ];
  const box = [17.8, 59.2, 18.6, 59.6];
  assert.deepEqual(
    districtsInView(districts, box, 10).map(({ c }) => c),
    ['mid', 'near', 'far'],
  );
  assert.equal(districtsInView(districts, box, 2).length, 2);
});

test('a point is found in a district, holes excepted', () => {
  const square = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ];
  const hole = [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
    [1, 1],
  ];
  assert.equal(polygonsContain([[square, hole]], [0.5, 0.5]), true);
  assert.equal(polygonsContain([[square, hole]], [2, 2]), false);
});

test("a district's card lists every party's share, largest first", () => {
  const card = buildDistrictCard({
    c: '01140101',
    n: 'Övra Runby',
    m: 'Upplands Väsby',
    v: 1038,
    t: 796,
    s: [304, 182, 175, 91, 67, 46, 66, 61, 8],
  });
  assert.equal(card.title, 'ELECTION DISTRICT · Övra Runby');
  assert.deepEqual(card.details, [
    'Upplands Väsby municipality',
    '1,038 votes counted here · turnout 79.6 %',
    'S 30.4 % · M 18.2 % · SD 17.5 %',
    'V 9.1 % · C 6.7 % · MP 6.6 %',
    'L 6.1 % · KD 4.6 % · Other parties 0.8 %',
    'Riksdag election 2026, final count · Valmyndigheten',
  ]);
  assert.equal(card.accent, PARTIES[0].color);
});
