// The card for one lightning stroke: what it says, and what it leaves out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGE_CLASSES } from './records.js';
import { buildStrikeCard } from './cards.js';

const NOW = Date.parse('2026-07-10T15:00:00Z');
const stroke = (extra = {}) => ({
  id: 'u3bq-01',
  point: [14.1868, 55.697],
  at: NOW - 3 * 60_000,
  kind: 'ground-negative',
  amp: -12.3,
  sensors: 4,
  ...extra,
});

test('the card tells when, what kind, how strong and how well located', () => {
  const card = buildStrikeCard(stroke(), NOW);
  assert.equal(card.id, 'lightning-strikes-card:u3bq-01');
  assert.equal(card.interactive, true);
  assert.equal(card.title, 'LIGHTNING STRIKE');
  assert.equal(card.details.length, 5);
  // Swedish time: 15:00 UTC in July is 17:00, three minutes earlier 16:57.
  assert.match(card.details[0], /^16:57:00 · /);
  assert.equal(card.details[1], 'Cloud to ground, negative');
  assert.equal(card.details[2], '12.3 kA peak current');
  assert.equal(card.details[3], 'Located by 4 sensors');
  assert.match(card.details[4], / · DMI$/);
  assert.equal(card.accent, AGE_CLASSES[0].color);
  assert.equal(
    buildStrikeCard(stroke({ at: NOW - 40 * 60_000 }), NOW).accent,
    AGE_CLASSES[3].color,
  );
});

test('the title and kind line follow the kind of stroke', () => {
  const cloud = buildStrikeCard(stroke({ kind: 'cloud' }), NOW);
  assert.equal(cloud.title, 'LIGHTNING · IN CLOUD');
  assert.equal(cloud.details[1], 'Cloud to cloud');
  assert.equal(
    buildStrikeCard(stroke({ kind: 'ground-positive' }), NOW).details[1],
    'Cloud to ground, positive',
  );
  const unknown = buildStrikeCard(stroke({ kind: null }), NOW);
  assert.equal(unknown.title, 'LIGHTNING STRIKE');
  assert.equal(unknown.details[1], 'Type not stated');
});

test('one sensor is one sensor, and a missing value is left out', () => {
  assert.equal(
    buildStrikeCard(stroke({ sensors: 1 }), NOW).details[3],
    'Located by 1 sensor',
  );
  for (const sensors of [null, 0]) {
    const card = buildStrikeCard(stroke({ sensors }), NOW);
    assert.equal(card.details.length, 4);
    assert.ok(!card.details.some((line) => line.startsWith('Located by')));
  }
  // No current stated is no line, never "0 kA"; a measured zero is kept.
  const silent = buildStrikeCard(stroke({ amp: null }), NOW);
  assert.equal(silent.details.length, 4);
  assert.ok(!silent.details.some((line) => line.includes('kA')));
  assert.equal(
    buildStrikeCard(stroke({ amp: 0 }), NOW).details[2],
    '0 kA peak current',
  );
});
