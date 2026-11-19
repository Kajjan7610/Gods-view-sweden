// Trafikverket's frost depth points: the frozen layer read from a profile of
// ground temperatures, and the points that still report.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  frostClass,
  frozenLayer,
  normalizeFrostDepthSnapshot,
} from './records.js';
import {
  buildFrostDepthCard,
  frostLabel,
  profileLines,
  wrapLine,
} from './cards.js';

const profile = (pairs) => pairs.map(([depth, value]) => ({ depth, value }));

test('the frost depth is where the profile crosses 0 °C below the frozen layer', () => {
  // Alfta, 19 November 2026: frozen in the top 35 cm.
  assert.deepEqual(
    frozenLayer(
      profile([
        [10, -1.1354],
        [35, -0.0521],
        [60, 1.3125],
        [85, 2.573],
      ]),
    ),
    { top: 0, bottom: 36, belowSensors: false },
  );
  // Nothing at or below 0 °C: no frost.
  assert.equal(
    frozenLayer(
      profile([
        [10, 0.4],
        [35, 2],
      ]),
    ),
    null,
  );
  // Thawed on top in spring, frozen beneath.
  assert.deepEqual(
    frozenLayer(
      profile([
        [10, 2],
        [35, -1],
        [60, -0.5],
        [85, 1],
      ]),
    ),
    { top: 27, bottom: 68, belowSensors: false },
  );
  // Frozen past the deepest sensor; the order of the rows does not matter.
  assert.deepEqual(
    frozenLayer(
      profile([
        [202, -0.77],
        [2, -12.25],
        [102, -10.25],
      ]),
    ),
    { top: 0, bottom: 202, belowSensors: true },
  );
});

test('the classes run from no frost to very deep', () => {
  assert.equal(frostClass(0).id, 'none');
  assert.equal(frostClass(null).id, 'none');
  assert.equal(frostClass(30).id, 'shallow');
  assert.equal(frostClass(79).id, 'moderate');
  assert.equal(frostClass(150).id, 'deep');
  assert.equal(frostClass(210).id, 'very-deep');
});

const answer = (points) => ({
  RESPONSE: { RESULT: [{ FrostDepthMeasurepoint: points }] },
});
const NOW = Date.parse('2026-11-19T14:00:00Z');

test('only points that reported within two days are kept; the rest are counted', () => {
  const { points, silent } = normalizeFrostDepthSnapshot(
    answer([
      {
        Id: '2136',
        Name: 'Alfta',
        Geometry: { WGS84: 'POINT (16.0336 61.3379)' },
        FrostDepth: {
          Sample: '2026-11-19T13:30:03.000+01:00',
          Temperature: [
            { Depth: 35, Value: -0.052083332 },
            { Depth: 10, Value: -1.1354166 },
            { Depth: 60, Value: 1.3125 },
          ],
        },
      },
      {
        Id: '1043',
        Name: 'Pello väg 99',
        Geometry: { WGS84: 'POINT Z (23.9461 66.8514 0)' },
        FrostDepth: {
          Sample: '2026-01-15T14:00:00.000+01:00',
          Temperature: [],
        },
      },
      { Id: 'x', Deleted: true },
      { Id: 'far', Geometry: { WGS84: 'POINT (2 48)' } },
    ]),
    NOW,
  );
  assert.equal(silent, 1);
  assert.equal(points.length, 1);
  const alfta = points[0];
  assert.deepEqual(alfta.point, [16.0336, 61.3379]);
  assert.equal(alfta.depth, 36);
  assert.deepEqual(
    alfta.profile.map((row) => [row.depth, row.value]),
    [
      [10, -1.1],
      [35, -0.1],
      [60, 1.3],
    ],
  );
  assert.equal(frostLabel(alfta), '36 cm');
  const card = buildFrostDepthCard(alfta);
  assert.equal(card.title, 'FROST DEPTH · ALFTA');
  assert.equal(card.details[0], 'Frozen to 36 cm');
  assert.match(card.details[1], /^In the ploughed road/);
  assert.ok(card.details.includes('10 cm −1.1° · 35 cm −0.1°'));
  assert.ok(card.details.includes('60 cm 1.3°'));
  assert.ok(card.details.some((line) => /^Reported /.test(line)));
  // Every line short enough for a phone.
  assert.ok(card.details.every((line) => line.length <= 38));
  assert.throws(() => normalizeFrostDepthSnapshot({}), /malformed/);
});

test('a dense sensor string is listed every few sensors', () => {
  const dense = profile(
    Array.from({ length: 41 }, (_, i) => [i * 5, i < 20 ? -1 : 1]),
  );
  const lines = profileLines(dense);
  assert.equal(lines.length, 5);
  assert.equal(lines.join(' · ').split(' · ').length, 9);
  assert.deepEqual(wrapLine('one two three', 7), ['one two', 'three']);
});

test('a string starting deep says what it measures, not a depth from the surface', () => {
  // Bunkris and its neighbours: the top sensor at 78 cm, already frozen.
  const deep = profile([
    [78, -2.9],
    [102, -1.1],
    [128, 0.1],
    [152, 1.1],
  ]);
  const frost = frozenLayer(deep);
  assert.equal(frost.top, null);
  assert.equal(frost.bottom, 126);
  const row = {
    id: 'b',
    name: 'Bunkris',
    profile: deep,
    frost,
    depth: 126,
    sampledAt: 0,
  };
  assert.equal(frostLabel(row), '78–126 cm');
  assert.equal(
    buildFrostDepthCard(row).details.slice(0, 2).join(' '),
    'Frozen at 78–126 cm; no sensors above 78 cm',
  );
  // A top sensor at 30 cm or less still speaks for the surface.
  assert.equal(
    frozenLayer(
      profile([
        [30, -1],
        [60, 1],
      ]),
    ).top,
    0,
  );
});
