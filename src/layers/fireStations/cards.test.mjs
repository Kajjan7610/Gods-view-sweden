// The fire station card: its title names a place only when that is fair.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFireStationCard } from './cards.js';

const row = (near, name) => ({
  id: 's1',
  point: [18.07, 59.33],
  readiness: 'retained',
  ...(name ? { name } : {}),
  ...(near ? { near } : {}),
});

test('a station near a municipal seat carries its name in the title', () => {
  const card = buildFireStationCard(row({ name: 'Stockholm', km: 5 }));
  assert.equal(card.title, 'FIRE STATION · STOCKHOLM');
  assert.equal(card.details[1], '5 km from Stockholm');
  assert.equal(
    buildFireStationCard(row({ name: 'Stockholm', km: 0 })).details[1],
    'In Stockholm',
  );
});

test('a station far from the seat is not named after it, and still says how far', () => {
  const card = buildFireStationCard(row({ name: 'Kiruna', km: 6 }));
  assert.equal(card.title, 'FIRE STATION');
  assert.equal(card.details[1], '6 km from Kiruna');
  assert.equal(buildFireStationCard(row(null)).title, 'FIRE STATION');
});

test('a station with a name of its own keeps it at any distance', () => {
  const card = buildFireStationCard(
    row({ name: 'Kiruna', km: 60 }, 'Karesuando'),
  );
  assert.equal(card.title, 'FIRE STATION · KARESUANDO');
});

test('the card is always hit-testable, so a click on it is never the ground', () => {
  assert.equal(buildFireStationCard(row(null)).interactive, true);
});
