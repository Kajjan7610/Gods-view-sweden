// Swedish fork: the Cockpit's visor corners say only true things. A ship's
// bridge names where its heading comes from (course or heading, from AIS);
// an aircraft or orbit view shows no made-up "OPTICAL PLANE · 01" or
// "VISOR LOCK · ACTIVE".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const view = readFileSync(
  new URL('./views/CockpitView.vue', import.meta.url),
  'utf8',
);

test('no optical plane or visor lock is drawn in any cockpit', () => {
  assert.doesNotMatch(view, /OPTICAL PLANE|VISOR LOCK/);
});

test('every visor corner is drawn on a ship bridge only', () => {
  // Each element with a cockpit-visor-status class, whatever its attribute
  // order: its v-if must require the bridge.
  const corners = [
    ...view.matchAll(/<div\b[^>]*\bcockpit-visor-status\b[^>]*>/g),
  ].map((match) => match[0]);
  assert.equal(corners.length, 2, corners.join('\n'));
  for (const corner of corners) {
    const condition = /v-if="([^"]*)"/.exec(corner)?.[1] ?? '';
    assert.match(condition, /(^|&&\s*)bridge(\s*&&|$)/, corner);
  }
});
