import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SWEDEN_CENTRE,
  SWEDISH_COUNTIES,
  createCountyLookup,
  normalizeCrisisItems,
  placeCrisisItem,
} from './crisis.js';
import { buildCrisisCard } from './cards.js';
import { createPlaceLookup } from '../policeEvents/records.js';

const GAZETTEER = [
  ['0180', 'Stockholms', 'Stockholm', 18.0, 59.3],
  ['0184', 'Solna', '', 18.0, 59.4],
  ['1980', 'Västerås', '', 16.5, 59.6],
];
const lookups = {
  places: createPlaceLookup(GAZETTEER),
  counties: createCountyLookup(GAZETTEER),
};

// Shaped like a live item from api.krisinformation.se/v3/news.
const NEWS = {
  identifier: '1238',
  published: '2026-11-03T12:33:06+01:00',
  updated: '2026-11-04T09:36:53+01:00',
  headline: 'Cyberangrepp mot frys- och kylsystem',
  preamble: 'Under måndagen drabbades frys- och kylsystem av ett cyberangrepp.',
  web: 'https://www.krisinformation.se/aktuellt/nyheter/cyberangrepp/',
  senderName: '',
  area: [{ type: 'Country', description: 'Sverige', coordinate: null }],
};

test('the 21 counties are named and centred on their municipality seats', () => {
  assert.equal(Object.keys(SWEDISH_COUNTIES).length, 21);
  assert.deepEqual(lookups.counties('Stockholms län'), [18, 59.35]);
  assert.deepEqual(lookups.counties('stockholms'), [18, 59.35]);
  assert.equal(lookups.counties('Skåne län'), null, 'no seat in the fixture');
});

test('items land on a coordinate, a municipality, a county or the whole country', () => {
  assert.deepEqual(
    placeCrisisItem([{ type: 'County', coordinate: '59.61,16.55' }], lookups)
      .point,
    [16.55, 59.61],
  );
  assert.deepEqual(
    placeCrisisItem(
      [{ type: 'Municipality', description: 'Västerås kommun' }],
      lookups,
    ),
    { point: [16.5, 59.6], place: 'Västerås kommun', scope: 'municipality' },
  );
  assert.equal(
    placeCrisisItem(
      [{ type: 'County', description: 'Stockholms län' }],
      lookups,
    ).scope,
    'county',
  );
  assert.deepEqual(placeCrisisItem(NEWS.area, lookups), {
    point: [...SWEDEN_CENTRE],
    place: 'Sverige',
    scope: 'country',
  });
});

test('VMAs come first; duplicates, untitled items and unsafe links drop', () => {
  const items = normalizeCrisisItems(
    {
      vmas: [
        {
          identifier: 'v1',
          headline: 'VMA: Brand i Västerås',
          published: '2026-11-04T10:00:00+01:00',
          area: [{ type: 'Municipality', description: 'Västerås' }],
          web: 'http://insecure.example/',
        },
      ],
      news: [NEWS, NEWS, { identifier: 'x' }],
    },
    lookups,
  );
  assert.deepEqual(
    items.map((row) => [row.id, row.kind, row.scope]),
    [
      ['vma:v1', 'vma', 'municipality'],
      ['news:1238', 'news', 'country'],
    ],
  );
  assert.equal(items[0].link, null);
  assert.equal(items[1].link, NEWS.web);
  assert.equal(items[1].sender, null);
});

test('the card names the scope, the preamble and the time', () => {
  const [row] = normalizeCrisisItems({ news: [NEWS] }, lookups);
  const card = buildCrisisCard(row, { linkable: true });
  assert.equal(
    card.title,
    'CRISIS INFORMATION · CYBERANGREPP MOT FRYS- OCH KYLSYSTEM',
  );
  assert.deepEqual(card.details, [
    'Applies to all of Sweden',
    'Under måndagen drabbades frys- och kylsystem av ett cyberangrepp.',
    '2026-11-03 12:33',
    'krisinformation.se ↗ · click card to open',
  ]);
  assert.equal(card.interactive, true);
});
