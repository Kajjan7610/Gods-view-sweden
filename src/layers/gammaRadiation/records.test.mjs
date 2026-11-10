// Strålsäkerhetsmyndigheten's gamma stations: current stations only, the
// service value kept apart from a reading, SSM's colour scale, and the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVICE_COLOR,
  buildGammaCard,
  doseClass,
  doseColor,
  normalizeGammaStations,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const feature = (id, name, lon, lat, date, value) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, name, date, value },
});

test('only stations that report now are kept, highest dose rate first', () => {
  const stations = normalizeGammaStations(
    {
      features: [
        // A moved station keeps its old entry beside the new one.
        feature(
          20,
          'Bjuruklubb (Skellefteå)',
          21.5725,
          64.4813,
          NOW - 400 * 864e5,
          -1,
        ),
        feature(
          1279,
          'Bjuröklubb (Skellefteå)',
          21.5725,
          64.4813,
          NOW - 36e5,
          0.094,
        ),
        feature(7, 'Gävle', 17.14, 60.67, NOW - 36e5, 0.121),
        feature(8, 'Ringhals', 12.11, 57.26, NOW - 36e5, -1),
        feature(9, 'Oslo', 10.75, 59.91, NOW - 36e5, 0.08),
        feature(10, 'Nowhere', 0, 0, NOW, 0.1),
      ],
    },
    NOW,
  );
  assert.deepEqual(
    stations.map(({ id, value }) => [id, value]),
    [
      ['7', 0.121],
      ['1279', 0.094],
      ['9', 0.08],
      ['8', null],
    ],
  );
  assert.deepEqual(stations[1].point, [21.5725, 64.4813]);
  assert.throws(() => normalizeGammaStations({}, NOW), /Malformed/);
});

test("colours follow SSM's scale; service is grey", () => {
  assert.equal(doseClass(0.03).max, 0.04);
  assert.equal(doseClass(0.094).max, 0.12);
  assert.equal(doseClass(0.12).max, 0.16, 'the upper bound is exclusive');
  assert.equal(doseClass(300).max, Infinity);
  assert.equal(doseClass(null), null);
  assert.equal(doseColor(-1), SERVICE_COLOR);
});

test('the card gives the reading, the normal background and the time', () => {
  const card = buildGammaCard(
    {
      id: '1279',
      name: 'Bjuröklubb (Skellefteå)',
      point: [21.5725, 64.4813],
      value: 0.094,
      updated: Date.parse('2026-11-05T13:00:00Z'),
    },
    NOW,
  );
  assert.equal(card.title, 'RADIATION · BJURÖKLUBB (SKELLEFTEÅ)');
  assert.deepEqual(card.details, [
    '0.094 µSv/h ambient dose rate',
    'Normal background in Sweden: 0.05–0.30 µSv/h',
    'Measured 14:00 · Strålsäkerhetsmyndigheten',
  ]);
  assert.equal(
    buildGammaCard({ id: '8', name: 'Ringhals', value: null, updated: NOW })
      .details[0],
    'Station in service or maintenance',
  );
});

test('a reading that is not from today carries its date', () => {
  const row = (updated, value = 0.1) => ({
    id: '1',
    name: 'Norrköping',
    point: [16.15, 58.58],
    value,
    updated,
  });
  const when = (updated, value) =>
    buildGammaCard(row(updated, value), NOW).details.at(-1);
  // NOW is 15:00 in Stockholm on 5 November.
  assert.equal(
    when(Date.parse('2026-11-05T13:00:00Z')),
    'Measured 14:00 · Strålsäkerhetsmyndigheten',
  );
  // Just before midnight the day before: yesterday, not "23:30" today.
  assert.equal(
    when(Date.parse('2026-11-04T22:30:00Z')),
    'Measured 2026-11-04 23:30 · Strålsäkerhetsmyndigheten',
  );
  // A station in service for 68 hours says when it last reported.
  const service = buildGammaCard(row(NOW - 68 * 3_600_000, null), NOW);
  assert.equal(service.details[0], 'Station in service or maintenance');
  assert.equal(
    service.details.at(-1),
    'Measured 2026-11-02 19:00 · Strålsäkerhetsmyndigheten',
  );
});

test('a station without any value is in service, never at 0 µSv/h', () => {
  const values = ['', '  ', null, undefined, 0, '0.094', -1];
  const stations = normalizeGammaStations(
    {
      features: values.map((value, index) =>
        feature(index, `S${index}`, 17, 60, NOW - 3_600_000, value),
      ),
    },
    NOW,
  );
  const byId = new Map(stations.map((row) => [row.id, row.value]));
  assert.deepEqual(
    values.map((_, index) => byId.get(String(index))),
    [null, null, null, null, 0, 0.094, null],
  );
});
