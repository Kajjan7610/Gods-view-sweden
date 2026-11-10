import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_OBSERVATION_AGE_MS,
  mergeObservations,
  summarizeForecast,
  symbolEmoji,
} from './records.js';
import { buildWeatherCard } from './cards.js';

const NOW = Date.parse('2026-11-04T22:00:00Z');
// Shaped like metobs latest-hour answers (one per parameter).
const station = (key, name, value, date = NOW - 60 * 60_000) => ({
  key,
  name,
  latitude: 68.3538,
  longitude: 18.8164,
  value: [{ date, value: String(value), quality: 'G' }],
});

test('parameters merge into one row per station; stale and empty readings drop', () => {
  const rows = mergeObservations(
    {
      airTemp: {
        station: [
          station('188790', 'Abisko Aut', '3.0'),
          station('1', 'Gammal', '1', NOW - MAX_OBSERVATION_AGE_MS - 1),
          { key: '2', name: 'Tom', latitude: 60, longitude: 15, value: null },
        ],
      },
      wind: { station: [station('188790', 'Abisko Aut', '6.1')] },
      gust: { station: [station('188790', 'Abisko Aut', '11.4')] },
    },
    NOW,
  );
  assert.deepEqual(rows, [
    {
      id: '188790',
      name: 'Abisko Aut',
      point: [18.8164, 68.3538],
      airTemp: 3,
      wind: 6.1,
      gust: 11.4,
      precipitation: null,
      updated: NOW - 60 * 60_000,
    },
  ]);
});

test('symbol codes map to emoji for every family', () => {
  assert.equal(symbolEmoji(1), '☀️');
  assert.equal(symbolEmoji(6), '☁️');
  assert.equal(symbolEmoji(7), '🌫️');
  assert.equal(symbolEmoji(19), '🌧️');
  assert.equal(symbolEmoji(26), '❄️');
  assert.equal(symbolEmoji(23), '🌨️');
  assert.equal(symbolEmoji(21), '⛈️');
  assert.equal(symbolEmoji(99), '');
});

test('a forecast summarises the next 24 hours and the following days', () => {
  const steps = [];
  for (let h = 0; h < 72; h += 3)
    steps.push({
      time: new Date(NOW + h * 3600e3).toISOString(),
      data: {
        air_temperature: h < 24 ? -1 + h / 6 : 2,
        wind_speed_of_gust: h === 6 ? 9.5 : 4,
        precipitation_amount_mean: h < 24 ? 0.5 : 0,
        symbol_code: h < 24 ? 18 : 1,
      },
    });
  const summary = summarizeForecast(
    { geometry: { coordinates: [16.55, 59.6] }, timeSeries: steps },
    NOW,
  );
  assert.deepEqual(summary.point, [16.55, 59.6]);
  assert.equal(summary.next24.min, -1);
  assert.equal(summary.next24.max, 2.5);
  assert.equal(summary.next24.gust, 9.5);
  assert.equal(summary.next24.precipitation, 4);
  assert.equal(summary.next24.symbol, 18);
  assert.ok(summary.days.length >= 2);
  assert.equal(summarizeForecast({}, NOW).next24, null);
});

test('the card shows the reading, then the forecast once it has arrived', () => {
  const row = {
    id: '188790',
    name: 'Abisko Aut',
    airTemp: 3,
    wind: 6.1,
    gust: 11.4,
    precipitation: null,
    updated: Date.parse('2026-11-04T21:00:00Z'),
  };
  const loading = buildWeatherCard(row);
  assert.equal(loading.title, 'WEATHER · ABISKO AUT');
  assert.deepEqual(loading.details, [
    'Now: +3.0 °C, wind 6.1 m/s, gusts 11.4',
    'Loading SMHI forecast …',
    'Measured 22:00 · SMHI',
  ]);
  const ready = buildWeatherCard(row, {
    forecastState: 'ready',
    forecast: {
      next24: { min: -1, max: 2.5, gust: 9.5, precipitation: 4, symbol: 18 },
      days: [],
    },
  });
  assert.equal(
    ready.details[1],
    'Next 24 h: 🌧️ -1.0 °C to +2.5 °C, gusts up to 9.5 m/s, 4.0 mm',
  );
  assert.equal(
    buildWeatherCard(row, { forecastState: 'failed' }).details[1],
    'SMHI forecast unavailable',
  );
});

test("the next 24 hours show the coming hour's symbol, a day its midday one", () => {
  const steps = [];
  for (let h = 0; h < 48; h += 1)
    steps.push({
      time: new Date(NOW + h * 3600e3).toISOString(),
      data: {
        air_temperature: 1,
        // Clear now, rain through the night, snow at Swedish midday.
        symbol_code: h === 0 ? 1 : h === 13 ? 25 : 18,
      },
    });
  const summary = summarizeForecast({ timeSeries: steps }, NOW);
  assert.equal(summary.next24.symbol, 1);
  // 22:00 UTC is 23:00 in Stockholm; the next day runs from step 1 to 24,
  // and its middle step is 12:00 Swedish time.
  assert.equal(summary.days[0].day, '2026-11-05');
  assert.equal(summary.days[0].symbol, 25);
});

test('a forecast is summarised without a new date formatter per step', (t) => {
  const steps = [];
  for (let h = 0; h < 240; h += 1)
    steps.push({
      time: new Date(NOW + h * 3600e3).toISOString(),
      data: { air_temperature: 1, symbol_code: 1 },
    });
  const made = t.mock.method(Intl, 'DateTimeFormat');
  const summary = summarizeForecast({ timeSeries: steps }, NOW);
  assert.equal(summary.days.length, 4);
  assert.equal(made.mock.callCount(), 0);
});
