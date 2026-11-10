import assert from 'node:assert/strict';
import test from 'node:test';
import { POWER_GRID_OVERLAY_SOURCE_ID, buildAreaCard } from './cards.js';
import { flowColor } from './records.js';

const UPDATED = Date.parse('2026-11-10T10:15:00Z');
const SE3 = { id: 'SE3', name: 'Stockholm' };
const link = (id, from, to, mw, kind) => ({ id, from, to, mw, kind });
const snapshot = (extra = {}) => ({
  links: [
    link('FI_SE3', 'SE3', 'FI', 387, 'export'),
    link('SE2_SE3', 'SE2', 'SE3', 5699, 'internal'),
    link('DE_SE4', 'DE', 'SE4', 188, 'import'),
  ],
  areas: [{ id: 'SE3', import: 5699, export: 387 }],
  production: { at: UPDATED, total: 17468, consumption: 17888, wind: 9637 },
  updated: UPDATED,
  ...extra,
});

test('a zone card is hit by clicks and has no page to open', () => {
  const card = buildAreaCard(SE3, snapshot());
  assert.equal(POWER_GRID_OVERLAY_SOURCE_ID, 'power-grid');
  assert.equal(card.id, 'power-grid-card:SE3');
  assert.equal(card.title, 'POWER GRID · SE3 STOCKHOLM');
  assert.equal(card.interactive, true);
  assert.equal(card.selected, true);
  assert.equal('activate' in card, false);
  assert.equal('accessibilityLabel' in card, false);
});

test('a zone card lists its own flows, then Sweden, then the time', () => {
  const card = buildAreaCard(SE3, snapshot());
  assert.deepEqual(card.details.slice(0, 4), [
    'Import 5,699 MW · export 387 MW',
    'from SE2 5,699 · to FI 387 MW',
    'Sweden: production 17,468 MW, consumption 17,888 MW',
    'wind 9,637 MW',
  ]);
  // 10:15 UTC in November is 11:15 in Stockholm.
  assert.equal(card.details[4], 'Svenska kraftnät · 11:15');
  assert.equal(card.details.length, 5);
});

test('an answer without production says so with a dash', () => {
  for (const production of [{}, { at: null }, undefined, { total: NaN }]) {
    const card = buildAreaCard(SE3, snapshot({ production }));
    assert.deepEqual(card.details, [
      'Import 5,699 MW · export 387 MW',
      'from SE2 5,699 · to FI 387 MW',
      'Sweden: production – MW, consumption – MW',
      'Svenska kraftnät · 11:15',
    ]);
    assert.doesNotMatch(card.details.join('\n'), /NaN|undefined|\b0 MW/);
  }
});

test('production without consumption keeps its value', () => {
  const card = buildAreaCard(
    SE3,
    snapshot({ production: { at: UPDATED, total: 17468, hydro: 0 } }),
  );
  assert.equal(
    card.details[2],
    'Sweden: production 17,468 MW, consumption – MW',
  );
  assert.equal(card.details.length, 4, 'a type at zero is not listed');
});

test('a card with nothing but the zone still reads', () => {
  const card = buildAreaCard(SE3, {
    links: [],
    areas: [],
    production: {},
    updated: null,
  });
  assert.deepEqual(card.details, [
    'Sweden: production – MW, consumption – MW',
    'Svenska kraftnät',
  ]);
});

test('the accent follows the zone’s net', () => {
  assert.equal(buildAreaCard(SE3, snapshot()).accent, flowColor('import'));
  assert.equal(
    buildAreaCard(
      SE3,
      snapshot({ areas: [{ id: 'SE3', import: 100, export: 900 }] }),
    ).accent,
    flowColor('export'),
  );
});
