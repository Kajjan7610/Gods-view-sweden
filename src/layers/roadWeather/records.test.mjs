import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ICE_RISK_COLOR,
  MAX_SAMPLE_AGE_MS,
  TEMPERATURE_CLASSES,
  iceRisk,
  normalizeWeatherSnapshot,
  normalizeWeatherStation,
  parsePoint,
  temperatureClass,
  temperatureColor,
} from './records.js';
import { buildStationCard, formatCelsius } from './cards.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');

// Shaped like a live WeatherMeasurepoint 2.1 record with the proxy's INCLUDEs.
const STATION = {
  Id: '222',
  Name: 'Stocksund',
  Geometry: { WGS84: 'POINT (18.04221 59.38437)' },
  Observation: {
    Sample: '2026-11-04T16:55:03.001+01:00',
    Weather: { Precipitation: 'no' },
    Surface: { Temperature: { Value: -1.4 } },
    Air: {
      Temperature: { Value: 0.6 },
      Dewpoint: { Value: -0.8 },
      RelativeHumidity: { Value: 86.4 },
      VisibleDistance: { Value: 20000 },
    },
    Wind: [{ Speed: { Value: 1.2 }, Direction: { Value: 223 } }],
    Aggregated10minutes: { Wind: { SpeedMax: { Value: 2.4 } } },
    Aggregated30minutes: {
      Precipitation: { TotalWaterEquivalent: { Value: 0 } },
    },
  },
};
const withObservation = (patch) => ({
  ...STATION,
  Observation: { ...STATION.Observation, ...patch },
});

test('WKT points parse; other geometry and null island do not', () => {
  assert.deepEqual(
    parsePoint('POINT (18.04221 59.38437)'),
    [18.04221, 59.38437],
  );
  assert.deepEqual(parsePoint('POINT Z (15 60 120)'), [15, 60]);
  assert.equal(parsePoint('LINESTRING (17 59, 18 60)'), null);
  assert.equal(parsePoint('POINT (0 0)'), null);
  assert.equal(parsePoint('POINT (200 60)'), null);
  assert.equal(parsePoint(undefined), null);
});

test('temperature classes put 0 °C on the freezing side and cover every value', () => {
  assert.equal(temperatureClass(0).id, 'minus-5-0');
  assert.equal(temperatureClass(0.1).id, 'zero-3');
  assert.equal(temperatureClass(-10).id, 'below-10');
  assert.equal(temperatureClass(-40).id, 'below-10');
  assert.equal(temperatureClass(35).id, 'above-8');
  assert.equal(temperatureClass(null), null);
  assert.equal(temperatureColor(Number.NaN), '#9e9e9e');
  const colors = TEMPERATURE_CLASSES.map(({ color }) => color);
  assert.equal(new Set(colors).size, colors.length);
  assert.ok(
    !colors.includes(ICE_RISK_COLOR),
    'the ice-risk ring stays distinct',
  );
});

test('a station normalizes its readings', () => {
  const row = normalizeWeatherStation(STATION, NOW);
  assert.deepEqual(
    { ...row },
    {
      id: '222',
      name: 'Stocksund',
      point: [18.04221, 59.38437],
      sampled: Date.parse('2026-11-04T16:55:03.001+01:00'),
      surfaceTemp: -1.4,
      airTemp: 0.6,
      dewpoint: -0.8,
      humidity: 86.4,
      visibility: 20000,
      windSpeed: 1.2,
      windDirection: 223,
      windGust: 2.4,
      precipitation: 'no',
      precipitation30: 0,
      surfaceIce: null,
      surfaceSnow: null,
      surfaceWater: null,
      grip: null,
      risk: 'frost',
    },
  );
});

test('surface-only sensors stay; stations without place, fresh sample or temperature do not', () => {
  const remote = normalizeWeatherStation(
    {
      Id: '601100',
      Name: '601 Gyllene Uttern Fjärryta',
      Geometry: { WGS84: 'POINT (14.44187 57.99488)' },
      Observation: {
        Sample: '2026-11-04T16:50:03.000+01:00',
        Surface: { Temperature: { Value: 2.1 } },
        Wind: [{ Height: 6 }],
      },
    },
    NOW,
  );
  assert.equal(remote.surfaceTemp, 2.1);
  assert.equal(remote.airTemp, null);
  assert.equal(remote.windSpeed, null);
  assert.equal(remote.risk, null);
  assert.equal(
    normalizeWeatherStation({ ...STATION, Geometry: {} }, NOW),
    null,
  );
  const old = new Date(NOW - MAX_SAMPLE_AGE_MS - 1).toISOString();
  assert.equal(
    normalizeWeatherStation(withObservation({ Sample: old }), NOW),
    null,
  );
  assert.equal(
    normalizeWeatherStation(
      withObservation({ Surface: {}, Air: { Dewpoint: { Value: 1 } } }),
      NOW,
    ),
    null,
  );
});

test('risk of ice: measured ice near zero, precipitation or frost on a frozen road', () => {
  const base = { surfaceTemp: -1, dewpoint: -3, precipitation: 'no' };
  assert.equal(iceRisk(base), null, 'cold and dry is not slippery');
  assert.equal(iceRisk({ ...base, dewpoint: -0.5 }), 'frost');
  assert.equal(iceRisk({ ...base, dewpoint: -1 }), 'frost');
  assert.equal(iceRisk({ ...base, precipitation: 'snow' }), 'precipitation');
  assert.equal(
    iceRisk({ ...base, surfaceTemp: 0.5, precipitation: 'rain' }),
    null,
  );
  assert.equal(
    iceRisk({ ...base, surfaceTemp: 0.8, surfaceIce: true }),
    'measured',
  );
  assert.equal(
    iceRisk({ ...base, surfaceTemp: 3.7, surfaceIce: true }),
    null,
    'a sensor reporting ice on a +3.7 °C road is not trusted',
  );
  assert.equal(iceRisk({ surfaceTemp: null, surfaceSnow: true }), 'measured');
  assert.equal(iceRisk({ surfaceTemp: null, dewpoint: 5 }), null);
});

test('the answer normalizes and drops duplicates and deleted points; an ERROR result throws', () => {
  const snapshot = normalizeWeatherSnapshot(
    {
      RESPONSE: {
        RESULT: [
          {
            WeatherMeasurepoint: [
              STATION,
              STATION,
              { ...STATION, Id: '223', Deleted: true },
              { Id: '224' },
            ],
          },
        ],
      },
    },
    NOW,
  );
  assert.equal(snapshot.stations.length, 1);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(normalizeWeatherSnapshot({}, NOW).stations, []);
  assert.throws(
    () =>
      normalizeWeatherSnapshot(
        {
          RESPONSE: {
            RESULT: [
              {
                ERROR: {
                  SOURCE: 'Security',
                  MESSAGE: 'Invalid authentication',
                },
              },
            ],
          },
        },
        NOW,
      ),
    (error) =>
      error.status === 401 && /Invalid authentication/.test(error.message),
  );
});

test('the card reads the station, its risk, wind, precipitation and sensor', () => {
  const row = normalizeWeatherStation(
    withObservation({
      Weather: { Precipitation: 'snow' },
      Surface: {
        Temperature: { Value: -2.25 },
        Ice: false,
        Snow: true,
        Water: false,
        Grip: { Value: 0.4 },
      },
      Air: {
        Temperature: { Value: -1 },
        Dewpoint: { Value: -2 },
        RelativeHumidity: { Value: 92.6 },
        VisibleDistance: { Value: 850 },
      },
      Aggregated30minutes: {
        Precipitation: { TotalWaterEquivalent: { Value: 0.6 } },
      },
    }),
    NOW,
  );
  const card = buildStationCard(row);
  assert.equal(card.title, 'ROAD WEATHER · STOCKSUND');
  assert.equal(card.id, 'trafikverket-weather-card:222');
  assert.equal(card.accent, temperatureColor(-2.25));
  assert.deepEqual(card.details, [
    'Road surface -2.3 °C',
    'Air -1.0 °C, dew point -2.0 °C, humidity 93 %',
    'Risk of ice: ice or snow measured on the road',
    'Wind 1.2 m/s, gusts 2.4 m/s, from 223°',
    'Precipitation: Snow, 0.6 mm in the last 30 min',
    'Surface sensor: snow, grip 0.40',
    'Visibility 0.9 km',
    'Measured 16:55 · Trafikverket road weather station',
  ]);
  assert.equal(
    buildStationCard({ ...row, airTemp: 9 }, { mode: 'air' }).accent,
    temperatureColor(9),
  );
  assert.equal(formatCelsius(0), '0.0 °C');
  assert.equal(formatCelsius(3), '+3.0 °C');
});
