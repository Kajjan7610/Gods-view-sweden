// SCB's population lookups for the city dossier (PxWebApi 2.0): town codes
// by name, the newest monthly table, and the two JSON-stat answers' shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCB_API,
  SCB_MONTHLY_TITLE,
  SCB_TOWN_TITLE,
  createScbPopulation,
  dimensionValues,
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

/** A JSON-stat dimension from codes and labels. */
const dimension = (codes, labels = codes) => ({
  category: {
    index: Object.fromEntries(codes.map((code, i) => [code, i])),
    label: Object.fromEntries(codes.map((code, i) => [code, labels[i]])),
  },
});

test('a town code is found by name inside its municipality', () => {
  assert.equal(townCode(REGION, '2180', ['Gävle']), '2180TC108');
  assert.equal(
    townCode(REGION, '0180', ['Stockholms', 'Stockholm']),
    '0180TC108',
  );
  assert.equal(townCode(REGION, '0128', ['Salemstaden', 'Salem']), null);
});

test('the table with the latest period wins, never a discontinued one', () => {
  const listing = {
    tables: [
      { id: 'TAB5444', label: `${SCB_MONTHLY_TITLE}. År 2000M01-2024M12`, lastPeriod: '2024M12' },
      { id: 'TAB6471', label: `${SCB_MONTHLY_TITLE}.  År 2025M01-2026M09`, lastPeriod: '2026M09' },
      { id: 'TAB9999', label: `${SCB_MONTHLY_TITLE}. Gammal`, lastPeriod: '2027M01', discontinued: true },
      { id: 'TAB1', label: 'Folkmängden efter region', lastPeriod: '2030' },
    ],
  };
  assert.equal(newestTable(listing, SCB_MONTHLY_TITLE), 'TAB6471');
  assert.equal(newestTable({ tables: [] }, 'x'), null);
  assert.equal(newestTable(null, 'x'), null);
});

test('a JSON-stat dimension reads in its index order', () => {
  const meta = {
    dimension: {
      Kon: {
        category: {
          index: { 1: 1, 2: 2, TotSa: 0 },
          label: { 1: 'män', 2: 'kvinnor', TotSa: 'totalt' },
        },
      },
    },
  };
  assert.deepEqual(dimensionValues(meta, 'Kon'), {
    values: ['TotSa', '1', '2'],
    valueTexts: ['totalt', 'män', 'kvinnor'],
  });
  assert.deepEqual(dimensionValues(meta, 'Saknas'), {
    values: [],
    valueTexts: [],
  });
});

test('SCB answers become the town year and the municipality month', () => {
  assert.deepEqual(
    normalizeTownAnswer({
      dimension: { Tid: dimension(['2025']) },
      value: [133067],
    }),
    { value: 133067, year: 2025 },
  );
  assert.equal(normalizeTownAnswer({ value: [] }), null);
  assert.deepEqual(
    normalizeMonthlyAnswer({
      dimension: {
        Kon: dimension(['TotSa', '1', '2']),
        Tid: dimension(['2026M09']),
      },
      value: [161967, 81008, 80960],
    }),
    { value: 161967, men: 81008, women: 80960, year: 2026, month: 9 },
  );
});

test('lookups find each table once and ask for the latest boundary and period', async () => {
  const calls = [];
  const scb = createScbPopulation(async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/tables')) {
      const town = /tätort/.test(searchParams.get('query'));
      return {
        tables: [
          {
            id: town ? 'TAB4060' : 'TAB6471',
            label: `${town ? SCB_TOWN_TITLE : SCB_MONTHLY_TITLE}. År 2005-2025`,
            lastPeriod: '2025',
          },
        ],
      };
    }
    if (pathname.endsWith('/TAB4060/metadata'))
      return {
        dimension: {
          Region: dimension(REGION.values, REGION.valueTexts),
          BasarTatort: dimension(['T2020', 'T2023']),
          ContentsCode: dimension(
            ['000006HJ', '000000WA'],
            ['Landareal, ha', 'Folkmängd'],
          ),
        },
      };
    if (pathname.endsWith('/TAB6471/metadata'))
      return {
        dimension: {
          Alder: dimension(['0', 'TotSA']),
          ContentsCode: dimension(['000007SF']),
        },
      };
    if (pathname.endsWith('/TAB4060/data'))
      return { dimension: { Tid: dimension(['2025']) }, value: [86981] };
    return {
      dimension: {
        Kon: dimension(['TotSa', '1', '2']),
        Tid: dimension(['2026M09']),
      },
      value: [104008, 52083, 51924],
    };
  });
  assert.deepEqual(await scb.townPopulation('2180', ['Gävle']), {
    value: 86981,
    year: 2025,
  });
  await scb.townPopulation('2180', ['Gävle']);
  assert.equal(calls.filter((url) => url.includes('/metadata')).length, 1);
  const data = new URL(calls.find((url) => url.includes('/TAB4060/data')));
  assert.equal(data.searchParams.get('valuecodes[BasarTatort]'), 'T2023');
  assert.equal(data.searchParams.get('valuecodes[ContentsCode]'), '000000WA');
  assert.equal(data.searchParams.get('valuecodes[Tid]'), 'top(1)');
  assert.equal(data.searchParams.get('outputFormat'), 'json-stat2');
  assert.ok(calls.every((url) => url.startsWith(SCB_API)));
  const month = await scb.municipalityPopulation('2180');
  assert.deepEqual(month, {
    value: 104008,
    men: 52083,
    women: 51924,
    year: 2026,
    month: 9,
  });
  const monthly = new URL(calls.find((url) => url.includes('/TAB6471/data')));
  assert.equal(monthly.searchParams.get('valuecodes[Alder]'), 'TotSA');
  assert.equal(monthly.searchParams.get('valuecodes[Kon]'), 'TotSa,1,2');
});

test('a town without a count has no population, never 0', () => {
  const answer = (cell) =>
    normalizeTownAnswer({
      dimension: { Tid: dimension(['2025']) },
      value: [cell],
    });
  assert.deepEqual(answer(86981), { value: 86981, year: 2025 });
  for (const empty of [null, '', '  ', '..', undefined])
    assert.equal(answer(empty), null);
});
