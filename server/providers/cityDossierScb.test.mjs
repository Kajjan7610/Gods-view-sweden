// SCB's population lookups for the city dossier: town codes by name, the
// newest monthly table, and the two answers' shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCB_POPULATION_FOLDER,
  SCB_TOWN_TABLE,
  createScbPopulation,
  newestTable,
  normalizeMonthlyAnswer,
  normalizeTownAnswer,
  townCode,
} from './cityDossierScb.js';

const REGION = {
  code: 'Region',
  values: ['T00', '2180TC108', '2181TC101', '0180TC108'],
  valueTexts: ['Summa riket', 'Gävle ', 'Gävle', 'Stockholm'],
};

test('a town code is found by name inside its municipality', () => {
  assert.equal(townCode(REGION, '2180', ['Gävle']), '2180TC108');
  assert.equal(
    townCode(REGION, '0180', ['Stockholms', 'Stockholm']),
    '0180TC108',
  );
  assert.equal(townCode(REGION, '0128', ['Salemstaden', 'Salem']), null);
});

test('the newest monthly population table wins', () => {
  assert.equal(
    newestTable(
      [
        {
          id: 'BefolkManad',
          type: 't',
          text: 'Folkmängden per månad efter region',
          updated: '2025-02-21T08:00:00',
        },
        {
          id: 'BefolkManadCKM',
          type: 't',
          text: 'Folkmängden per månad efter region',
          updated: '2026-10-07T08:00:00',
        },
        {
          id: 'BE0101B',
          type: 'l',
          text: 'Folkmängden per månad',
          updated: '2027-01-01',
        },
      ],
      'Folkmängden per månad',
    ),
    'BefolkManadCKM',
  );
  assert.equal(newestTable([], 'x'), null);
});

test('SCB answers become the town year and the municipality month', () => {
  assert.deepEqual(
    normalizeTownAnswer({
      data: [{ key: ['2180TC108', 'T2023', '2025'], values: ['86981'] }],
    }),
    { value: 86981, year: 2025 },
  );
  assert.equal(normalizeTownAnswer({ data: [] }), null);
  assert.deepEqual(
    normalizeMonthlyAnswer({
      data: [
        { key: ['2180', 'TotSA', 'TotSa', '2026M08'], values: ['104008'] },
        { key: ['2180', 'TotSA', '1', '2026M08'], values: ['52083'] },
        { key: ['2180', 'TotSA', '2', '2026M08'], values: ['51924'] },
      ],
    }),
    { value: 104008, men: 52083, women: 51924, year: 2026, month: 8 },
  );
});

test('lookups read the metadata once and query with the latest boundary', async () => {
  const calls = [];
  const scb = createScbPopulation(async (url, init) => {
    calls.push([
      url,
      init?.body?.query?.map((q) => [q.code, q.selection.values].flat()),
    ]);
    if (url === SCB_TOWN_TABLE && !init)
      return {
        variables: [
          REGION,
          { code: 'BasarTatort', values: ['T2020', 'T2023'] },
          { code: 'ContentsCode', values: ['000000WA', '000006HJ'] },
        ],
      };
    if (url === SCB_TOWN_TABLE)
      return {
        data: [{ key: ['2180TC108', 'T2023', '2025'], values: ['86981'] }],
      };
    if (url === SCB_POPULATION_FOLDER)
      return [
        {
          id: 'BefolkManadCKM',
          type: 't',
          text: 'Folkmängden per månad',
          updated: '2026',
        },
      ];
    if (!init)
      return {
        variables: [
          { code: 'Alder', values: ['TotSA'] },
          { code: 'ContentsCode', values: ['000007SF'] },
        ],
      };
    return {
      data: [
        { key: ['2180', 'TotSA', 'TotSa', '2026M08'], values: ['104008'] },
      ],
    };
  });
  assert.deepEqual(await scb.townPopulation('2180', ['Gävle']), {
    value: 86981,
    year: 2025,
  });
  await scb.townPopulation('2180', ['Gävle']);
  assert.equal(
    calls.filter(([url, q]) => url === SCB_TOWN_TABLE && !q).length,
    1,
  );
  assert.deepEqual(calls[1][1][1], ['BasarTatort', 'T2023']);
  assert.equal((await scb.municipalityPopulation('2180')).value, 104008);
});

import { normalizeTownAnswer as townAnswer } from './cityDossierScb.js';

test('a town without a count has no population, never 0', () => {
  const answer = (cell) =>
    townAnswer({ data: [{ key: ['T1', '2025'], values: [cell] }] });
  assert.deepEqual(answer('86981'), { value: 86981, year: 2025 });
  for (const empty of [null, '', '  ', '..', undefined])
    assert.equal(answer(empty), null);
});
