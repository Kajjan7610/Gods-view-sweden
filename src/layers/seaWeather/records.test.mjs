import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  classOf,
  meanWaterLevel,
  mergeSmhiSea,
} from './records.js';
import { buildSeaCard, seaColor } from './cards.js';

// 23:00 in Stockholm, a quarter after the reading below.
const NOW = Date.parse('2026-11-04T22:00:00Z');
// One station's row as the layer gets it.
const ROW = Object.freeze({
  id: '114',
  name: 'Vinga',
  point: [11.6047, 57.632],
  level: -18,
  levelReference: 'MVY',
  waterTemp: 10.1,
  waveHeight: 0.8,
  updated: Date.parse('2026-11-04T21:46:55Z'),
});

test('classes cover every value and their colours differ', () => {
  assert.equal(classOf(LEVEL_CLASSES, -18).id, 'low');
  assert.equal(classOf(LEVEL_CLASSES, 55).id, 'very-high');
  assert.equal(classOf(LEVEL_CLASSES, null), null);
  assert.equal(new Set(LEVEL_CLASSES.map((c) => c.color)).size, 5);
});

test('the card reads water level, water temperature and waves', () => {
  const row = ROW;
  const card = buildSeaCard(row, { nowMs: NOW });
  assert.equal(card.title, 'SEA WEATHER · VINGA');
  assert.deepEqual(card.details, [
    'Water level -18 cm against mean water',
    'Water +10.1 °C',
    'Wave height 0.8 m',
    'Measured 22:46 · SMHI',
  ]);
  assert.equal(card.accent, seaColor(row));
  assert.equal(card.accent, LEVEL_CLASSES[1].color);
});

test('only a level against mean water is classed and coloured', () => {
  const row = (levelReference, level = 48) => ({
    id: '1',
    name: 'Skoghall',
    point: [13.4385, 59.3163],
    level,
    levelReference,
    updated: NOW - 60_000,
  });
  assert.equal(meanWaterLevel(row('MVY')), 48);
  assert.equal(meanWaterLevel(row('Sjökortsnivå')), null);
  assert.equal(meanWaterLevel(row('RH2000')), null);
  assert.equal(meanWaterLevel(row(null)), null);
  assert.equal(meanWaterLevel({ ...row('MVY'), level: null }), null);
  // 48 cm above chart datum in Vänern is no "very high" water.
  assert.equal(seaColor(row('MVY')), LEVEL_CLASSES.at(-1).color);
  assert.equal(seaColor(row('Sjökortsnivå')), NO_VALUE_COLOR);
  // The card names the zero the station measures from.
  const line = (reference, level) =>
    buildSeaCard(row(reference, level), { nowMs: NOW }).details[0];
  assert.equal(line('MVY', -18), 'Water level -18 cm against mean water');
  assert.equal(line('Sjökortsnivå'), 'Water level +48 cm against sjökortsnivå');
  assert.equal(line('RH2000', 74), 'Water level +74 cm against RH 2000');
  assert.equal(line(null), 'Water level +48 cm');
});

test('the card dates a reading that is not from today', () => {
  const row = ROW;
  assert.equal(
    buildSeaCard(row, { nowMs: NOW + 2 * 3_600_000 }).details.at(-1),
    'Measured 2026-11-04 22:46 · SMHI',
  );
});

test("SMHI's ocean files merge into one row per station against mean water", () => {
  const at = NOW - 70 * 60_000;
  const smhiStation = (key, name, values, lat = 57.43, lon = 11.94) => ({
    key,
    name,
    latitude: lat,
    longitude: lon,
    value: values,
  });
  const rows = mergeSmhiSea(
    {
      level: {
        station: [
          // The day's file can end in an empty sample: the newest value counts.
          smhiStation('2111', 'Onsala', [
            { date: at - 3_600_000, value: '7.5', quality: 'O' },
            { date: at, value: '9.6', quality: 'O' },
            { date: at + 60_000, value: '', quality: 'O' },
          ]),
          smhiStation('9', 'Gammal', [
            { date: NOW - 4 * 3_600_000, value: '30', quality: 'G' },
          ]),
          smhiStation('8', 'Utanför', [{ date: at, value: '5' }], 40, 11),
        ],
      },
      waterTemp: {
        station: [smhiStation('2111', 'Onsala', [{ date: at, value: '9.12' }])],
      },
      waveHeight: {
        station: [
          smhiStation('33', 'Väderöarna Vågboj', [{ date: at, value: '0.97' }]),
        ],
      },
    },
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [
      row.id,
      row.source,
      row.level,
      row.levelReference,
      row.waterTemp,
      row.waveHeight,
    ]),
    [
      ['smhi:2111', 'smhi', 9.6, 'MVY', 9.12, null],
      ['smhi:33', 'smhi', null, null, null, 0.97],
    ],
  );
  assert.equal(meanWaterLevel(rows[0]), 9.6);
  assert.equal(rows[0].updated, at);
});

test("an SMHI station's card names SMHI", () => {
  const card = buildSeaCard(
    {
      id: 'smhi:2111',
      source: 'smhi',
      name: 'Onsala',
      level: 9.6,
      levelReference: 'MVY',
      waterTemp: 9.1,
      waveHeight: null,
      updated: NOW - 70 * 60_000,
    },
    { nowMs: NOW },
  );
  assert.match(card.details.at(-1), /· SMHI$/);
  assert.equal(
    buildSeaCard({ id: 'x', source: 'smhi', name: 'X', updated: null })
      .details.at(-1),
    'SMHI',
  );
});
