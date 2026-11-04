import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEVEL_CLASSES,
  WIND_CLASSES,
  classOf,
  normalizeSeaStation,
  sampleNumber,
  stockholmTime,
} from './records.js';
import { buildSeaCard, seaColor } from './cards.js';

// Shaped like a live ViVa answer (vivastation/114, Vinga).
const STATION = { ID: 114, Name: 'Vinga', Lat: 57.632, Lon: 11.6047 };
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
  const row = normalizeSeaStation(STATION, SAMPLES);
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
    normalizeSeaStation({ ...STATION, Lat: 0, Lon: 0 }, SAMPLES),
    null,
  );
});

test('the card reads wind, water level and water temperature', () => {
  const row = normalizeSeaStation(STATION, SAMPLES);
  const card = buildSeaCard(row);
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
