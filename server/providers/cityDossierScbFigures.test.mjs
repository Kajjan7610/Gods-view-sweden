// The city dossier's further SCB figures: JSON-stat cells, region codes,
// table titles, and births and moves, houses, building, new cars and
// commuting read from their tables.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCB_TABLES,
  createScbPopulation,
  jsonStatCells,
  newestTable,
  regionCode,
} from './cityDossierScb.js';

/** A JSON-stat answer or metadata from [id, label, codes, texts] rows. */
const stat = (dims, value = []) => ({
  id: dims.map(([id]) => id),
  size: dims.map(([, , codes]) => codes.length),
  dimension: Object.fromEntries(
    dims.map(([id, label, codes, texts = codes]) => [
      id,
      {
        label,
        category: {
          index: Object.fromEntries(codes.map((code, i) => [code, i])),
          label: Object.fromEntries(codes.map((code, i) => [code, texts[i]])),
        },
      },
    ]),
  ),
  value,
});

test('JSON-stat cells carry their coordinates; empty cells are left out', () => {
  const answer = stat(
    [
      ['A', 'a', ['a1', 'a2']],
      ['B', 'b', ['b1', 'b2', 'b3']],
    ],
    [1, 2, null, 4, '', 6],
  );
  assert.deepEqual(
    jsonStatCells(answer).map(({ coords, value }) => [
      coords.A,
      coords.B,
      value,
    ]),
    [
      ['a1', 'b1', 1],
      ['a1', 'b2', 2],
      ['a2', 'b1', 4],
      ['a2', 'b3', 6],
    ],
  );
  // A sparse answer is an object keyed by position.
  assert.equal(jsonStatCells({ ...answer, value: { 5: 9 } })[0].coords.B, 'b3');
});

test('a municipality is found by its code, a text starting with it, or a suffix', () => {
  const values = (codes, texts) => ({ values: codes, valueTexts: texts });
  assert.equal(regionCode(values(['0180'], ['Stockholm']), '0180'), '0180');
  assert.equal(
    regionCode(values(['x1'], ['0180 Stockholm (bostad)']), '0180'),
    'x1',
  );
  assert.equal(regionCode(values(['0180B'], ['Stockholm']), '0180'), '0180B');
  assert.equal(regionCode(values(['01801'], ['x']), '0180'), null);
});

test('a title with two spaces before its period still finds the newest table', () => {
  const listing = {
    tables: [
      {
        id: 'TAB1625',
        label:
          'Befolkningsstatistik efter region och kön. Månad 2000M01-2024M12',
        lastPeriod: '2024M12',
      },
      {
        id: 'TAB6473',
        label:
          'Befolkningsstatistik efter region och kön.  Månad 2025M01-2026M09',
        lastPeriod: '2026M09',
      },
      {
        id: 'TAB6481',
        label:
          'Befolkningsstatistik per kvartal/halvår/helår efter region och kön.  År 2025-2026',
        lastPeriod: '2026',
      },
    ],
  };
  assert.equal(newestTable(listing, SCB_TABLES.changes.match), 'TAB6473');
  // The variant with special housing split out is another table.
  const starts = {
    tables: [
      {
        id: 'TAB6925',
        label:
          'Lägenheter i nybyggda hus efter region och hustyp (specialbostäder uppdelat). Kvartal 2007K1-2026K2',
        lastPeriod: '2026K2',
      },
      {
        id: 'TAB4572',
        label:
          'Lägenheter i nybyggda hus efter region och hustyp. Kvartal 1975K1-2026K2',
        lastPeriod: '2026K2',
      },
    ],
  };
  assert.equal(newestTable(starts, SCB_TABLES.starts.match), 'TAB4572');
});

const REGION = ['Region', 'region', ['1980', '00'], ['Västerås', 'Riket']];
const TABLES = {
  TAB6473: stat([
    REGION,
    [
      'Forandringar',
      'förändringar',
      ['N1', 'N2', 'Y1'],
      ['födda', 'döda', 'flyttningsöverskott totalt'],
    ],
    ['Kon', 'kön', ['1+2', '1'], ['totalt, samtliga män och kvinnor', 'män']],
    ['ContentsCode', 'tabellinnehåll', ['C1'], ['Antal']],
    ['Tid', 'månad', ['2026M09']],
  ]),
  TAB1169: stat([
    REGION,
    [
      'Fastighetstyp',
      'fastighetstyp',
      ['220', '221'],
      ['permanentbostad (ej tomträtt)', 'fritidshus'],
    ],
    [
      'ContentsCode',
      'tabellinnehåll',
      ['N', 'P'],
      ['Antal', 'Köpeskilling, medelvärde i tkr'],
    ],
    ['Tid', 'år', ['2025']],
  ]),
  TAB4572: stat([
    REGION,
    ['Hustyp', 'hustyp', ['FB', 'SH'], ['flerbostadshus', 'småhus']],
    [
      'ContentsCode',
      'tabellinnehåll',
      ['P', 'F'],
      [
        'Påbörjade lägenheter i nybyggda hus',
        'Färdigställda lägenheter i nybyggda hus',
      ],
    ],
    ['Tid', 'kvartal', ['2025K3', '2025K4', '2026K1', '2026K2']],
  ]),
  TAB3277: stat([
    REGION,
    ['Drivmedel', 'drivmedel', ['100', '120'], ['bensin', 'el']],
    ['ContentsCode', 'tabellinnehåll', ['A'], ['Antal']],
    ['Tid', 'månad', ['2026M09', '2026M10']],
  ]),
  TAB1830: stat([
    ['Kon', 'kön', ['1', '2', '1+2'], ['män', 'kvinnor', 'totalt']],
    [
      'Bostadskommun',
      'bostadskommun',
      ['1980', '0180'],
      ['1980 Västerås (bostad)', '0180 Stockholm (bostad)'],
    ],
    [
      'Arbetsstallekommun',
      'arbetsställekommun',
      ['1980', '0180'],
      ['1980 Västerås (arbetsställe)', '0180 Stockholm (arbetsställe)'],
    ],
    ['ContentsCode', 'tabellinnehåll', ['S'], ['Sysselsatta']],
    ['Tid', 'år', ['2024']],
  ]),
};
const LABELS = [
  [
    'TAB6473',
    'Befolkningsstatistik efter region och kön.  Månad 2025M01-2026M09',
  ],
  [
    'TAB1169',
    'Försålda småhus efter region (kommun, län, riket) och fastighetstyp. År 1981-2025',
  ],
  [
    'TAB4572',
    'Lägenheter i nybyggda hus efter region och hustyp. Kvartal 1975K1-2026K2',
  ],
  [
    'TAB3277',
    'Nyregistrerade personbilar efter län och kommun samt drivmedel. Månad 2006M01-2026M10',
  ],
  [
    'TAB1830',
    'Sysselsatta 15–74 år efter bostadskommun, arbetsställekommun och kön. Årligt register. År 2020-2024',
  ],
];

/** SCB as the figures read it: listings, metadata and small answers. */
function fakeScb(urls) {
  return async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/tables'))
      return {
        tables: LABELS.map(([id, label]) => ({
          id,
          label,
          lastPeriod: '2026',
        })),
      };
    const id = u.pathname.split('/')[4];
    if (u.pathname.endsWith('/metadata')) return TABLES[id];
    switch (id) {
      case 'TAB6473':
        return stat(
          [
            ['Forandringar', 'f', ['N1', 'N2', 'Y1']],
            ['Tid', 't', ['2026M09']],
          ],
          [153, 90, -49],
        );
      case 'TAB1169':
        return stat(
          [
            ['ContentsCode', 'c', ['N', 'P']],
            ['Tid', 't', ['2025']],
          ],
          [784, 4182],
        );
      case 'TAB4572':
        return stat(
          [
            ['Hustyp', 'h', ['FB', 'SH']],
            ['Tid', 't', ['2025K3', '2025K4', '2026K1', '2026K2']],
          ],
          [100, 50, 60, 51, 20, 30, 25, 25],
        );
      case 'TAB3277':
        return stat(
          [
            ['Drivmedel', 'd', ['100', '120']],
            ['Tid', 't', ['2026M09', '2026M10']],
          ],
          [30, 10, 40, 20],
        );
      case 'TAB1830':
        // The town as home with every workplace, or as workplace.
        return u.searchParams.get('valuecodes[Bostadskommun]') === '1980'
          ? stat(
              [
                [
                  'Arbetsstallekommun',
                  'a',
                  ['1980', '0180'],
                  [
                    '1980 Västerås (arbetsställe)',
                    '0180 Stockholm (arbetsställe)',
                  ],
                ],
                ['Tid', 't', ['2024']],
              ],
              [64291, 2996],
            )
          : stat(
              [
                [
                  'Bostadskommun',
                  'b',
                  ['1980', '0180'],
                  ['1980 Västerås (bostad)', '0180 Stockholm (bostad)'],
                ],
                ['Tid', 't', ['2024']],
              ],
              [64291, 1200],
            );
      default:
        throw new Error(`unexpected ${url}`);
    }
  };
}

test('the further figures: births and moves, houses, building, new cars and commuting', async () => {
  const urls = [];
  const { figures, failed } = await createScbPopulation(fakeScb(urls), {
    limit: Infinity,
  }).municipalityFigures('1980');
  assert.deepEqual(failed, []);
  assert.deepEqual(figures.changes, {
    year: 2026,
    month: 9,
    births: 153,
    deaths: 90,
    netMoves: -49,
  });
  assert.deepEqual(figures.houses, {
    year: 2025,
    sold: 784,
    meanPrice: 4182000,
  });
  assert.deepEqual(figures.starts, {
    from: '2025K3',
    to: '2026K2',
    started: 361,
  });
  assert.equal(figures.cars.total, 100);
  assert.equal(figures.cars.electric, 60);
  assert.equal(figures.cars.share, 60);
  assert.deepEqual(figures.commuting, {
    year: 2024,
    local: 64291,
    out: 2996,
    in: 1200,
    topOut: { name: 'Stockholm', count: 2996 },
    topIn: { name: 'Stockholm', count: 1200 },
  });
  const decoded = urls.map((url) => decodeURIComponent(url));
  // Every municipality by SCB's wildcard, never a list of 290 codes.
  assert.ok(
    decoded.some((url) => url.includes('valuecodes[Arbetsstallekommun]=*')),
  );
  // The totals are asked for, not one sex.
  assert.ok(decoded.some((url) => url.includes('valuecodes[Kon]=1+2')));
});

test('a table that fails is named, and the others still answer', async () => {
  const scb = fakeScb([]);
  const { figures, failed } = await createScbPopulation(
    async (url) =>
      url.includes('TAB3277') ? Promise.reject(new Error('down')) : scb(url),
    { limit: Infinity },
  ).municipalityFigures('1980');
  assert.equal(figures.cars, null);
  assert.match(failed[0], /^cars: down/);
  assert.ok(figures.houses);
});

/** A clock that moves only when the throttle waits. */
function fakeTime() {
  const time = { clock: 0, waits: [] };
  time.now = () => time.clock;
  time.wait = async (ms) => {
    time.waits.push(ms);
    // Calls already granted go out before the clock moves on.
    await new Promise((resolve) => setTimeout(resolve, 0));
    time.clock += ms;
  };
  return time;
}

test('SCB is asked at most ten times per ten seconds, however many towns ask', async () => {
  const time = fakeTime();
  const sentAt = [];
  const scb = fakeScb([]);
  const population = createScbPopulation(
    async (url) => {
      sentAt.push(time.clock);
      return scb(url);
    },
    { now: time.now, wait: time.wait, laterQueueMax: Infinity },
  );
  const answers = await Promise.all(
    ['1980', '1980', '1980', '1980'].map((code) =>
      population.municipalityFigures(code),
    ),
  );
  assert.ok(answers.every(({ failed }) => failed.length === 0));
  assert.ok(sentAt.length > 20, 'enough calls to need the window');
  for (const start of sentAt)
    assert.ok(
      sentAt.filter((at) => at >= start && at < start + 10_000).length <= 10,
      `more than ten calls in the ten seconds from ${start}`,
    );
});

test('the further figures leave three calls of every window to the town population', async () => {
  const time = fakeTime();
  const sentAt = [];
  const scb = fakeScb([]);
  const population = createScbPopulation(
    async (url) => {
      sentAt.push(time.clock);
      return scb(url);
    },
    {
      now: time.now,
      wait: time.wait,
      laterQueueMax: Infinity,
      laterWaitMs: Infinity,
    },
  );
  await Promise.all(
    ['1980', '1980', '1980'].map((code) =>
      population.municipalityFigures(code),
    ),
  );
  for (const start of sentAt)
    assert.ok(
      sentAt.filter((at) => at >= start && at < start + 10_000).length <= 7,
    );
});

test('a full line turns the figures away at once', async () => {
  const time = fakeTime();
  const population = createScbPopulation(fakeScb([]), {
    now: time.now,
    wait: time.wait,
    limit: 1,
    windowMs: 1000,
    laterQueueMax: 3,
    laterWaitMs: Infinity,
  });
  const answers = await Promise.all(
    [1, 2, 3, 4, 5].map(() => population.municipalityFigures('1980')),
  );
  const turnedAway = answers.filter(({ failed }) =>
    failed.some((failure) => /queue full/.test(failure)),
  );
  assert.ok(turnedAway.length >= 2, 'a full line answers at once');
});

test('the town population is sent before figures that were asked for first', async () => {
  const time = fakeTime();
  const sent = [];
  const scb = fakeScb([]);
  const isTown = (url) => /folkm/i.test(decodeURIComponent(url));
  const population = createScbPopulation(
    async (url) => {
      sent.push(isTown(url) ? 'town' : 'figure');
      return isTown(url) ? { tables: [] } : scb(url);
    },
    { now: time.now, wait: time.wait, limit: 1, windowMs: 1000 },
  );
  // Three towns' figures queue up, then one town's population is asked.
  const figures = ['1980', '0180', '1984'].map((code) =>
    population.municipalityFigures(code),
  );
  const town = population.municipalityPopulation('1980').catch(() => null);
  await Promise.all([...figures, town]);
  const first = sent.indexOf('town');
  assert.ok(first >= 0, 'the town read was sent');
  // Only the figure call already granted goes before it; a plain queue
  // would send the town read last.
  assert.ok(first <= 1, `the town read waited: ${sent.join()}`);
  assert.ok(sent.length > 4);
});
