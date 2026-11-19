// SLU's wastewater file: the four respiratory viruses after the method
// change, each plant's trend, Swedish spelling restored, and the plants a
// town is matched to.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  METHOD_FROM,
  normalizeWastewater,
  townKey,
  wastewaterFor,
  wastewaterTrend,
} from './wastewater.js';

const HEADER =
  'target,sample,sampling_date,city,inhabitants,copies_l,copies_day_inhabitant,pmmov_normalised,category,flow';
/** One CSV row: target, date, city, level and category. */
const row = (target, date, city, level, category = 'Positive sample') =>
  `${target},s,${date},${city},1000,1,1,${level},${category},1`;

test('a trend compares the newest level with the two before it', () => {
  assert.equal(wastewaterTrend([1, 1, 2]), 'rising');
  assert.equal(wastewaterTrend([1, 1, 1.2]), 'steady');
  assert.equal(wastewaterTrend([2, 2, 1]), 'falling');
  assert.equal(wastewaterTrend([1, 1, 0]), 'none');
  // Found after samples without it: no ratio to speak of.
  assert.equal(wastewaterTrend([0, 0, 0.3]), 'detected');
  assert.equal(wastewaterTrend([0.3]), 'detected');
  // Only the two samples before count.
  assert.equal(wastewaterTrend([9, 1, 1, 1]), 'steady');
});

test('the file as plants: four viruses, after the method change, negatives as zero', () => {
  const csv = [
    HEADER,
    row('SARS CoV-2', '2026-08-24', 'Vasteras', 99),
    row('SARS CoV-2', METHOD_FROM, 'Vasteras', 1),
    row('SARS CoV-2', '2026-09-07', 'Vasteras', 1),
    row('SARS CoV-2', '2026-09-14', 'Vasteras', 2),
    row('Influenza A virus', '2026-09-14', 'Vasteras', 0.5, 'Negative sample'),
    row('PMMoV', '2026-09-14', 'Vasteras', 1000),
    row('Norovirus GII', '2026-09-14', 'Vasteras', 3),
    row('RSV', '2026-09-14', 'Stockholm-Kappala', 0.2),
    '',
  ].join('\r\n');
  const { plants, latestWeek, methodFrom } = normalizeWastewater(csv);
  assert.equal(latestWeek, '2026-09-14');
  assert.equal(methodFrom, METHOD_FROM);
  assert.deepEqual(
    plants.map(({ city, place, plant }) => [city, place, plant]),
    [
      ['Stockholm-Kappala', 'Stockholm', 'Käppala'],
      ['Vasteras', 'Västerås', null],
    ],
  );
  const vasteras = plants[1];
  assert.deepEqual(vasteras.viruses, [
    // The sample before the method change is not read: 1, 1, 2 rises.
    { virus: 'covid', trend: 'rising', date: '2026-09-14' },
    // A negative sample is not detected, whatever its level says.
    { virus: 'fluA', trend: 'none', date: '2026-09-14' },
  ]);
  assert.equal(vasteras.latest, '2026-09-14');
  assert.equal(vasteras.outOfDate, false);
});

test('a plant weeks behind the others is marked out of date', () => {
  const { plants } = normalizeWastewater(
    [
      HEADER,
      row('RSV', '2026-09-07', 'Umea', 0),
      row('RSV', '2026-11-09', 'Lulea', 0),
    ].join('\n'),
  );
  assert.deepEqual(
    plants.map(({ place, outOfDate }) => [place, outOfDate]),
    [
      ['Luleå', false],
      ['Umeå', true],
    ],
  );
});

test('a file without the expected columns is refused', () => {
  assert.throws(() => normalizeWastewater('target,city\nRSV,Umea'), /lacks/);
});

test('a town finds its own plants by name or municipality, never a neighbour', () => {
  const plant = (city, outOfDate = false) => ({
    city,
    key: townKey(city),
    outOfDate,
  });
  const snapshot = {
    plants: [
      plant('Goteborg'),
      plant('Stockholm-Bromma'),
      plant('Stockholm-Henriksdal'),
      plant('Stockholm-Kappala', true),
      plant('Stockholmsund'),
    ],
  };
  assert.equal(townKey('Göteborg'), 'goteborg');
  assert.deepEqual(
    wastewaterFor(snapshot, { name: 'Göteborg' }).map((p) => p.city),
    ['Goteborg'],
  );
  // Stockholm's current plants, not the one weeks behind nor a lookalike.
  assert.deepEqual(
    wastewaterFor(snapshot, { name: 'Stockholm' }).map((p) => p.city),
    ['Stockholm-Bromma', 'Stockholm-Henriksdal'],
  );
  // A town named differently from its municipality.
  assert.deepEqual(
    wastewaterFor(snapshot, {
      name: 'Hisings Backa',
      municipality: 'Göteborg',
    }).map((p) => p.city),
    ['Goteborg'],
  );
  assert.deepEqual(wastewaterFor(snapshot, { name: 'Arboga' }), []);
  assert.deepEqual(wastewaterFor(null, { name: 'Arboga' }), []);
});

test('a positive sample without a level, or a row with a shifted column, is left out', () => {
  const { plants } = normalizeWastewater(
    [
      HEADER,
      row('RSV', '2026-09-07', 'Umea', 0.4),
      row('RSV', '2026-09-14', 'Umea', ''),
      `RSV,s,2026-09-14,"Umea, north",1000,1,1,9,Positive sample,1`,
    ].join('\n'),
  );
  assert.deepEqual(plants[0].viruses, [
    { virus: 'rsv', trend: 'detected', date: '2026-09-07' },
  ]);
});
