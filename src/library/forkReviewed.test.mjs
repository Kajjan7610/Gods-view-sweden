import test from 'node:test';
import assert from 'node:assert/strict';
import { FORK_REVIEWED_ENTRIES, LIBRARY_ENTRIES } from './catalog.js';

test('only the reviewed entries are offered without the operator switching them on', () => {
  const offered = LIBRARY_ENTRIES.filter(
    (entry) => entry.licence.operatorOptIn !== true,
  ).map((entry) => entry.id);
  assert.deepEqual(offered.sort(), [...FORK_REVIEWED_ENTRIES].sort());
});

test('every reviewed entry exists, and its tiles come over https from its provider', () => {
  const byId = new Map(LIBRARY_ENTRIES.map((entry) => [entry.id, entry]));
  for (const id of FORK_REVIEWED_ENTRIES) {
    const entry = byId.get(id);
    assert.ok(entry, `${id} is in the catalog`);
    assert.match(entry.source.url, /^https:\/\//, id);
    assert.ok(entry.attribution?.text, `${id} names its credit`);
  }
});

test('the surface water entry draws the newest JRC dataset (1984–2024)', () => {
  const water = LIBRARY_ENTRIES.find(({ id }) => id === 'jrc-surface-water');
  assert.match(water.source.url, /\/water-world\/tiles2024\/occurrence\//);
  assert.match(water.description, /1984 and 2024/);
});
