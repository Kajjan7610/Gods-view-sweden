// The visit passport: stamps once per town, stored safely, challenges
// counted against Sweden's map.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COUNTY_SEAT_CODES,
  PASSPORT_STORAGE_KEY,
  challengeProgress,
  REVISIT_GAP_MS,
  loadPassport,
  mostVisited,
  savePassport,
  stampVisit,
  stampsInOrder,
  totalVisits,
} from './visitPassport.js';

const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test('a town is stamped once; later visits count, a quick return does not', () => {
  const passport = loadPassport(memory());
  const gavle = {
    code: '2180',
    name: 'Gävle',
    county: 'Gävleborgs län',
    point: [17.14, 60.67],
  };
  assert.equal(stampVisit(passport, gavle, 1000), true);
  // Panning back within ten minutes is the same visit.
  assert.equal(stampVisit(passport, gavle, 2000), false);
  assert.equal(passport.stamps['2180'].count, 1);
  const later = 2000 + REVISIT_GAP_MS;
  assert.equal(stampVisit(passport, gavle, later), false);
  assert.deepEqual(passport.stamps['2180'], {
    name: 'Gävle',
    county: 'Gävleborgs län',
    point: [17.14, 60.67],
    first: 1000,
    last: later,
    count: 2,
  });
  assert.equal(stampVisit(passport, { code: 'x' }, 3000), false);
});

test('the passport survives storage, and broken storage gives a fresh one', () => {
  const storage = memory();
  const passport = loadPassport(storage);
  stampVisit(
    passport,
    { code: '0180', name: 'Stockholm', point: [18.07, 59.33] },
    5,
  );
  passport.showMap = true;
  savePassport(storage, passport);
  const again = loadPassport(storage);
  assert.equal(again.stamps['0180'].name, 'Stockholm');
  assert.equal(again.showMap, true);
  assert.equal(again.cinematic, true);
  storage.setItem(PASSPORT_STORAGE_KEY, '{broken');
  assert.deepEqual(loadPassport(storage).stamps, {});
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadPassport(throwing).stamps, {});
  assert.doesNotThrow(() => savePassport(throwing, again));
});

test('challenges: county seats, counties, the Arctic Circle and all towns', () => {
  const passport = loadPassport(memory());
  const visit = (code, lat, at) =>
    stampVisit(passport, { code, name: code, point: [18, lat] }, at);
  visit('2180', 60.67, 3); // Gävle, a county seat
  visit('2181', 60.9, 1); // Sandviken, same county
  visit('2584', 67.86, 2); // Kiruna, north of the circle
  visit('2580', 65.58, 4); // Luleå, a county seat south of it
  const progress = Object.fromEntries(
    challengeProgress(passport).map((row) => [
      row.id,
      `${row.done}/${row.total}`,
    ]),
  );
  assert.deepEqual(progress, {
    seats: '2/21',
    counties: '2/21',
    arctic: '1/3',
    all: '4/290',
  });
  assert.equal(COUNTY_SEAT_CODES.length, 21);
  assert.deepEqual(
    stampsInOrder(passport).map((s) => s.code),
    ['2181', '2584', '2180', '2580'],
  );
});

test('visits in all, and the towns returned to most', () => {
  const passport = loadPassport(memory());
  const town = (code, name) => ({ code, name, point: [18, 59] });
  let at = 0;
  const visit = (code, name) => {
    at += REVISIT_GAP_MS;
    stampVisit(passport, town(code, name), at);
  };
  for (const [code, name] of [
    ['0180', 'Stockholm'],
    ['1980', 'Västerås'],
    ['0180', 'Stockholm'],
    ['2584', 'Kiruna'],
    ['0180', 'Stockholm'],
    ['1980', 'Västerås'],
  ])
    visit(code, name);
  assert.equal(totalVisits(passport), 6);
  assert.deepEqual(
    mostVisited(passport, 2).map((stamp) => [stamp.name, stamp.count]),
    [
      ['Stockholm', 3],
      ['Västerås', 2],
    ],
  );
  // An old passport without counts reads as one visit each.
  assert.equal(totalVisits({ stamps: { '0180': { name: 'x' } } }), 1);
});
