import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  WIND_CLASSES,
  classOf,
  meanWaterLevel,
  normalizeSeaStation,
  sampleNumber,
  stockholmTime,
} from './records.js';
import { buildSeaCard, seaColor } from './cards.js';

// Shaped like a live ViVa answer (vivastation/114, Vinga).
const STATION = { ID: 114, Name: 'Vinga', Lat: 57.632, Lon: 11.6047 };
// 23:00 in Stockholm, a quarter after the samples below.
const NOW = Date.parse('2026-11-04T22:00:00Z');
const SAMPLES = [
  {
    Name: 'Vattenstånd',
    Value: '-18',
    Heading: 0,
    Unit: 'cm',
    Type: 'level',
    Updated: '2026-11-04 22:45:00',
    Quality: 'Ok',
    WaterLevelReference: 'MVY',
  },
  {
    Name: 'Byvind',
    Value: 'SV 7.4',
    Heading: 243,
    Unit: 'm/s',
    Type: 'wind',
    Updated: '2026-11-04 22:46:55',
    Quality: 'Ok',
  },
  {
    Name: 'Medelvind',
    Value: 'SV 6.7',
    Heading: 243,
    Unit: 'm/s',
    Type: 'wind',
    Updated: '2026-11-04 22:46:55',
    Quality: 'Ok',
  },
  {
    Name: 'Vattentemp',
    Value: '10.1',
    Unit: '°C',
    Type: 'watertemp',
    Updated: '2026-11-04 22:40:00',
    Quality: 'Ok',
  },
  { Name: 'Lufttemp', Value: '99', Quality: 'Error' },
];

test('values and Swedish local times parse', () => {
  assert.equal(sampleNumber('SV 7.4'), 7.4);
  assert.equal(sampleNumber('-18'), -18);
  assert.equal(sampleNumber('calm'), null);
  assert.equal(
    stockholmTime('2026-11-04 22:45:00'),
    Date.parse('2026-11-04T21:45:00Z'),
    'CET in November',
  );
  assert.equal(
    stockholmTime('2026-07-01 12:00:00'),
    Date.parse('2026-07-01T10:00:00Z'),
    'CEST in July',
  );
  assert.equal(stockholmTime('soon'), null);
});

test('classes cover every value and their colours differ', () => {
  assert.equal(classOf(WIND_CLASSES, 6.7).id, 'moderate');
  assert.equal(classOf(WIND_CLASSES, 25).id, 'storm');
  assert.equal(classOf(LEVEL_CLASSES, -18).id, 'low');
  assert.equal(classOf(LEVEL_CLASSES, 55).id, 'very-high');
  assert.equal(classOf(WIND_CLASSES, null), null);
  assert.equal(new Set(WIND_CLASSES.map((c) => c.color)).size, 5);
  assert.equal(new Set(LEVEL_CLASSES.map((c) => c.color)).size, 5);
});

test('a station keeps good samples only; one without any drops', () => {
  const row = normalizeSeaStation(STATION, SAMPLES, NOW);
  assert.deepEqual(
    { ...row },
    {
      id: '114',
      name: 'Vinga',
      point: [11.6047, 57.632],
      meanWind: 6.7,
      gust: 7.4,
      windHeading: 243,
      level: -18,
      levelReference: 'MVY',
      waterTemp: 10.1,
      airTemp: null,
      waveHeight: null,
      visibility: null,
      updated: Date.parse('2026-11-04T21:46:55Z'),
    },
  );
  assert.equal(normalizeSeaStation(STATION, []), null);
  assert.equal(
    normalizeSeaStation({ ...STATION, Lat: 0, Lon: 0 }, SAMPLES, NOW),
    null,
  );
});

test('the card reads wind, water level and water temperature', () => {
  const row = normalizeSeaStation(STATION, SAMPLES, NOW);
  const card = buildSeaCard(row, { nowMs: NOW });
  assert.equal(card.title, 'SEA WEATHER · VINGA');
  assert.deepEqual(card.details, [
    'Wind 6.7 m/s, gusts 7.4 m/s, from 243°',
    'Water level -18 cm against mean water',
    'Water +10.1 °C',
    'Measured 22:46 · Sjöfartsverket ViVa',
  ]);
  assert.equal(card.accent, seaColor(row, 'wind'));
  assert.equal(
    buildSeaCard(row, { mode: 'level' }).accent,
    seaColor(row, 'level'),
  );
});

test('a value older than three hours is not the current weather', () => {
  const sample = (Name, Value, Updated, extra = {}) => ({
    Name,
    Value,
    Updated,
    Quality: 'Ok',
    ...extra,
  });
  // The wind sensor fell silent in the afternoon; the level is from now.
  const row = normalizeSeaStation(
    STATION,
    [
      sample('Medelvind', 'SV 14.0', '2026-11-04 15:10:00', { Heading: 243 }),
      sample('Byvind', 'SV 19.0', '2026-11-04 15:10:00'),
      sample('Vattenstånd', '-18', '2026-11-04 22:45:00', {
        WaterLevelReference: 'MVY',
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    [row.meanWind, row.gust, row.windHeading, row.level],
    [null, null, null, -18],
  );
  assert.equal(row.updated, Date.parse('2026-11-04T21:45:00Z'));
  // Just inside three hours it still counts.
  assert.equal(
    normalizeSeaStation(
      STATION,
      [sample('Medelvind', 'SV 14.0', '2026-11-04 20:00:00')],
      NOW,
    ).meanWind,
    14,
  );
  // Nothing but old values: no station.
  assert.equal(
    normalizeSeaStation(
      STATION,
      [sample('Vattentemp', '10.1', '2026-11-03 22:45:00')],
      NOW,
    ),
    null,
  );
});

test('only a level against mean water is classed and coloured', () => {
  const row = (levelReference, level = 48) => ({
    id: '1',
    name: 'Skoghall',
    point: [13.4385, 59.3163],
    meanWind: null,
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
  assert.equal(seaColor(row('MVY'), 'level'), LEVEL_CLASSES.at(-1).color);
  assert.equal(seaColor(row('Sjökortsnivå'), 'level'), NO_VALUE_COLOR);
  // The card names the zero the station measures from.
  const line = (reference, level) =>
    buildSeaCard(row(reference, level), { nowMs: NOW }).details[0];
  assert.equal(line('MVY', -18), 'Water level -18 cm against mean water');
  assert.equal(line('Sjökortsnivå'), 'Water level +48 cm against sjökortsnivå');
  assert.equal(line('RH2000', 74), 'Water level +74 cm against RH 2000');
  assert.equal(line(null), 'Water level +48 cm');
});

test('the card dates a reading that is not from today', () => {
  const row = normalizeSeaStation(STATION, SAMPLES, NOW);
  assert.equal(
    buildSeaCard(row, { nowMs: NOW + 2 * 3_600_000 }).details.at(-1),
    'Measured 2026-11-04 22:46 · Sjöfartsverket ViVa',
  );
});
