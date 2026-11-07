// Aviation weather as said: wind, visibility, clouds, the one-line summary
// and the decoded rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloudText,
  visibilityText,
  weatherLine,
  weatherRows,
  windText,
} from './aviationWeatherView.js';

const report = (extra = {}) => ({
  icao: 'ESGG',
  observed: Date.parse('2026-11-07T11:20:00Z'),
  windDir: 50,
  windVariable: false,
  windKt: 3,
  gustKt: null,
  visibilityM: 9999,
  cavok: false,
  clouds: [
    { cover: 'FEW', baseFt: 1400 },
    { cover: 'BKN', baseFt: 2400 },
  ],
  ceilingFt: 2400,
  temperatureC: 5,
  dewpointC: 3,
  qnhHpa: 1028,
  weather: null,
  category: 'MVFR',
  metar: 'METAR ESGG …',
  taf: null,
  ...extra,
});

test('wind: three-figure direction, variable, calm, gusts', () => {
  assert.equal(windText(report()), '050° 3 kt');
  assert.equal(
    windText(report({ windVariable: true, windDir: null })),
    'variable 3 kt',
  );
  assert.equal(windText(report({ windKt: 0 })), 'calm');
  assert.equal(
    windText(report({ windKt: 18, gustKt: 30, windDir: 270 })),
    '270° 18 kt gusts 30 kt',
  );
  assert.equal(windText(report({ windKt: null })), '');
});

test('visibility and clouds: the ceiling leads, CAVOK says so', () => {
  assert.equal(visibilityText(report()), '10 km or more');
  assert.equal(visibilityText(report({ visibilityM: 800 })), '800 m');
  assert.match(visibilityText(report({ visibilityM: 2500 })), /^2[.,]5 km$/);
  assert.match(cloudText(report()), /^broken clouds 2[,  ]?400 ft$/);
  assert.equal(cloudText(report({ cavok: true })), 'CAVOK');
  assert.equal(cloudText(report({ clouds: [] })), '');
});

test('one line, and the rows of the weather tab', () => {
  assert.match(
    weatherLine(report()),
    /^050° 3 kt · 10 km or more · broken clouds .+ · 5 °C$/,
  );
  assert.equal(weatherLine(null), '');
  const rows = weatherRows(report({ weather: '-RA' }));
  assert.deepEqual(
    rows.map((row) => row.label),
    [
      'Observed',
      'Wind',
      'Visibility',
      'Clouds',
      'Weather',
      'Temperature',
      'QNH',
    ],
  );
  assert.match(
    rows.find((row) => row.label === 'Clouds').value,
    /few clouds .+, broken clouds/,
  );
  assert.match(
    rows.find((row) => row.label === 'Temperature').value,
    /dew point 3 °C/,
  );
  assert.equal(rows.find((row) => row.label === 'QNH').value, '1028 hPa');
});
