import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WARNING_LEVELS,
  levelColor,
  normalizeWarningArea,
  normalizeWarnings,
  polygonsOf,
  warningLevel,
} from './records.js';
import { buildWarningCard, foldText, warningLanguage } from './cards.js';

const NOW = Date.parse('2026-11-04T17:00:00Z');

// Shaped like a live warning from SMHI's IBWW API (version 1).
const SQUARE = [
  [18, 67],
  [19, 67],
  [19, 68],
  [18, 68],
  [18, 67],
];
const AREA = {
  id: 10729,
  approximateStart: '2026-11-04T11:00:00.466Z',
  approximateEnd: '2026-11-05T05:00:00.665Z',
  published: '2026-11-03T10:43:54.500Z',
  areaName: { sv: 'Norra Lapplandsfjällen', en: 'Northern Lapland Mountains' },
  warningLevel: { sv: 'Orange', en: 'Orange', code: 'ORANGE' },
  eventDescription: {
    sv: 'Vind i kombination med snöfall på kalfjället',
    en: 'Wind and snow in the alpine region',
    code: 'WIND_MOUNTAINS_SNOW',
  },
  affectedAreas: [{ id: 25, sv: 'Norrbottens län', en: 'Norrbotten County' }],
  descriptions: [
    {
      title: { sv: 'Vad händer?', en: 'What happens?', code: 'HAPPENS' },
      text: {
        sv: 'Mycket hård västvind på kalfjället, 18-24 m/s.',
        en: 'Very strong westerly wind on the bare mountains, 18-24 m/s.',
      },
    },
    {
      title: {
        sv: 'Vad ska jag tänka på?',
        en: 'What should I think about?',
        code: 'AFFECT',
      },
      text: {
        sv: 'Ge dig inte ut på fjället i onödan.\nRisken för förfrysning är stor.',
        en: 'No hiking is recommended in mountainous areas.\nThe risk of frostbite is high.',
      },
    },
  ],
  area: {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [SQUARE] },
    properties: {},
  },
};
const WARNING = {
  id: 3387,
  event: {
    sv: 'Vind på kalfjället',
    en: 'Wind in the alpine region',
    code: 'WIND_MOUNTAINS',
  },
  warningAreas: [AREA],
};

test('levels run from message to red, each with its own colour', () => {
  assert.deepEqual(
    WARNING_LEVELS.map(({ code }) => code),
    ['MESSAGE', 'YELLOW', 'ORANGE', 'RED'],
  );
  assert.equal(warningLevel('orange').rank, 2);
  assert.equal(warningLevel('PURPLE'), null);
  assert.equal(levelColor('PURPLE'), '#9e9e9e');
  const colors = WARNING_LEVELS.map(({ color }) => color);
  assert.equal(new Set(colors).size, colors.length);
});

test('polygons and multipolygons keep outer rings and holes; junk rings drop', () => {
  assert.deepEqual(polygonsOf({ type: 'Polygon', coordinates: [SQUARE] }), [
    { outer: SQUARE, holes: [] },
  ]);
  const multi = polygonsOf({
    type: 'MultiPolygon',
    coordinates: [
      [
        SQUARE,
        [
          [18.2, 67.2],
          [18.4, 67.2],
          [18.4, 67.4],
          [18.2, 67.2],
        ],
      ],
      [
        [
          [20, 60],
          [21, 60],
        ],
      ],
    ],
  });
  assert.equal(multi.length, 1, 'a two-point ring is no polygon');
  assert.equal(multi[0].holes.length, 1);
  assert.deepEqual(polygonsOf({ type: 'Point', coordinates: [18, 67] }), []);
  assert.deepEqual(
    polygonsOf({
      type: 'Polygon',
      coordinates: [
        [
          [18.123456789, 67],
          [19, 67],
          [19, 68],
        ],
      ],
    })[0].outer[0],
    [18.12346, 67],
  );
});

test('a warning area normalizes with both languages, its time window and texts', () => {
  const row = normalizeWarningArea(WARNING, AREA, NOW);
  assert.equal(row.id, '3387:10729');
  assert.equal(row.level, 'ORANGE');
  assert.equal(row.eventCode, 'WIND_MOUNTAINS');
  assert.deepEqual(row.area, {
    sv: 'Norra Lapplandsfjällen',
    en: 'Northern Lapland Mountains',
  });
  assert.deepEqual(row.counties, [
    { sv: 'Norrbottens län', en: 'Norrbotten County' },
  ]);
  assert.equal(row.start, Date.parse('2026-11-04T11:00:00.466Z'));
  assert.equal(row.end, Date.parse('2026-11-05T05:00:00.665Z'));
  assert.equal(row.upcoming, false);
  assert.deepEqual(
    row.texts.map((entry) => entry.code),
    ['HAPPENS', 'AFFECT'],
  );
  assert.equal(row.polygons.length, 1);
});

test('ended areas and areas without level or polygon drop; upcoming ones stay', () => {
  assert.equal(
    normalizeWarningArea(
      WARNING,
      { ...AREA, approximateEnd: '2026-11-04T16:00:00Z' },
      NOW,
    ),
    null,
  );
  assert.equal(
    normalizeWarningArea(WARNING, { ...AREA, warningLevel: {} }, NOW),
    null,
  );
  assert.equal(normalizeWarningArea(WARNING, { ...AREA, area: {} }, NOW), null);
  const later = normalizeWarningArea(
    WARNING,
    { ...AREA, approximateStart: '2026-11-05T05:00:00Z' },
    NOW,
  );
  assert.equal(later.upcoming, true);
  // A message with no end (water shortage) runs until further notice.
  const open = normalizeWarningArea(
    WARNING,
    { ...AREA, approximateEnd: undefined, areaName: { sv: 'Skåne län' } },
    NOW,
  );
  assert.equal(open.end, null);
  assert.deepEqual(open.area, { sv: 'Skåne län', en: 'Skåne län' });
});

test('the answer sorts least severe first; malformed answers throw', () => {
  const { areas, truncated } = normalizeWarnings(
    [
      WARNING,
      {
        id: 3122,
        event: { sv: 'Risk för vattenbrist', en: 'Risk for water shortage' },
        warningAreas: [
          {
            ...AREA,
            id: 9873,
            warningLevel: { code: 'MESSAGE' },
            approximateEnd: undefined,
          },
        ],
      },
    ],
    NOW,
  );
  assert.deepEqual(
    areas.map((row) => row.level),
    ['MESSAGE', 'ORANGE'],
  );
  assert.equal(truncated, false);
  assert.throws(() => normalizeWarnings({ warnings: [] }, NOW), /Malformed/);
});

test('the card reads the level, headline, place, window and advice', () => {
  const row = normalizeWarningArea(WARNING, AREA, NOW);
  const card = buildWarningCard(row, { linkable: true, language: 'en' });
  assert.equal(
    card.title,
    'ORANGE WARNING · WIND AND SNOW IN THE ALPINE REGION',
  );
  assert.equal(card.accent, levelColor('ORANGE'));
  assert.equal(card.interactive, true);
  assert.deepEqual(card.details, [
    'Northern Lapland Mountains · Norrbotten County',
    '2026-11-04 12:00 → 2026-11-05 06:00',
    'Very strong westerly wind on the bare mountains, 18-24 m/s.',
    'No hiking is recommended in mountainous areas.',
    'The risk of frostbite is high.',
    'Published 2026-11-03 11:43 · SMHI',
    'SMHI ↗ · click card to open',
  ]);
  const swedish = buildWarningCard(row, { language: 'sv' });
  assert.equal(swedish.details[0], 'Norra Lapplandsfjällen · Norrbottens län');
  // Without a link the card is hit-testable all the same, and offers no page.
  assert.equal(swedish.interactive, true);
  assert.equal(swedish.accessibilityLabel, undefined);
  assert.equal(warningLanguage('sv'), 'sv');
  assert.equal(warningLanguage('de'), 'en');
});

test('long SMHI prose folds into short card lines with an ellipsis', () => {
  const prose =
    'Wednesday afternoon the westerly wind will continue to be very strong on the bare mountains, 18-24 m/s. At times on the eastern side the wind can reach storm force 25-30 m/s. At the same time precipitation in the high terrain will increasingly turn into sleet or snow.';
  const lines = foldText(prose, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.length <= 80));
  assert.ok(lines[1].endsWith('…'));
  assert.ok(prose.startsWith(lines[0]));
  assert.deepEqual(foldText('Short text.', 3), ['Short text.']);
  assert.deepEqual(foldText('', 3), []);
  assert.equal(foldText('x'.repeat(120), 2)[0].length, 80);
});
