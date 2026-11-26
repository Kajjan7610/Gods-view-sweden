// Swedish fork: an "<X> urban area" whose town "<X>" is in the pack for the
// same country is left out, so a view over Stockholm is named Stockholm, not
// "Stockholm urban area".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withoutUrbanAreaTwins } from './wikidataCities.js';

test('an urban area beside its own town is left out; others stay', () => {
  const rows = [
    ['Stockholm urban area', 59.31, 18.046, 1652895, 'SE', 'Q94385'],
    ['Stockholm', 59.329, 18.069, 984748, 'SE', 'Q1754'],
    ['Lonely urban area', 10, 10, 50000, 'XX', 'Q1'],
    ['Stockholm urban area', 1, 1, 20000, 'ZZ', 'Q2'],
    ['Göteborg', 57.7, 11.97, 600000, 'SE', 'Q25287'],
  ];
  assert.deepEqual(
    withoutUrbanAreaTwins(rows).map((row) => row[5]),
    ['Q1754', 'Q1', 'Q2', 'Q25287'],
  );
});

test('the bundled pack loses exactly its urban-area twins (Stockholm, Oslo)', () => {
  const pack = JSON.parse(
    readFileSync(
      new URL('./local_data/wikidata_cities/cities.json', import.meta.url),
      'utf8',
    ),
  );
  const kept = withoutUrbanAreaTwins(pack.rows);
  const dropped = pack.rows
    .filter((row) => !kept.includes(row))
    .map((row) => row[0])
    .sort();
  assert.deepEqual(dropped, ['Oslo urban area', 'Stockholm urban area']);
  // Drammen has no town row of its own, so its urban area is its only name.
  assert.ok(kept.some((row) => row[0] === 'Drammen urban area'));
  assert.ok(kept.some((row) => row[0] === 'Stockholm' && row[4] === 'SE'));
});
