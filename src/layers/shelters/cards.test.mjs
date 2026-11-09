import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShelterCard, formatShelterDistance } from './cards.js';

test('a distance is rounded before its unit is chosen', () => {
  assert.equal(formatShelterDistance(44), '40 m');
  assert.equal(formatShelterDistance(994), '990 m');
  assert.equal(formatShelterDistance(996), '1 km');
  assert.equal(formatShelterDistance(1000), '1 km');
  assert.equal(formatShelterDistance(12000), '12 km');
  assert.equal(formatShelterDistance(undefined), '');
});

test('the card of a shelter can be hit, so a click on it is not the ground', () => {
  const card = buildShelterCard({
    id: '7',
    number: '10007-7',
    property: 'Sundin 20',
    places: 60,
    limited: true,
    special: false,
    distance: 996,
  });
  assert.equal(card.id, 'shelters-card:7');
  assert.equal(card.interactive, true);
  assert.equal(card.accent, '#ffb74d');
  assert.ok(card.details.some((line) => line.includes('1 km')));
});
