import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVATION_MAX_AGE_MS,
  eaqiLevel,
  normalizeSmhiReadings,
} from './model.js';
import {
  createCombinedAirQualitySource,
  createSmhiAirQualitySource,
} from './source.js';
import { createAirQualityLayer } from './index.js';

const NOW = Date.parse('2026-11-04T22:00:00Z');

test('EAQI levels follow the European hourly limits', () => {
  assert.equal(eaqiLevel('NO2', 12), 1);
  assert.equal(eaqiLevel('NO2', 40), 1);
  assert.equal(eaqiLevel('NO2', 41), 2);
  assert.equal(eaqiLevel('PM2.5', 30), 4);
  assert.equal(eaqiLevel('PM10', 160), 6);
  assert.equal(eaqiLevel('O3', 0), 1);
  assert.equal(eaqiLevel('NO2', -3), null);
  assert.equal(eaqiLevel('SO2', 10), null);
  assert.equal(eaqiLevel('NO2', Number.NaN), null);
});

test('a station scores its worst pollutant; stale pollutants drop', () => {
  const rows = normalizeSmhiReadings(
    [
      {
        id: '59.3400,18.0570',
        name: 'Stockholm Hornsgatan',
        lat: 59.34,
        lon: 18.057,
        pollutants: {
          NO2: { value: 95.2, at: NOW - 60 * 60_000 },
          PM10: { value: 12, at: NOW - 60 * 60_000 },
          O3: { value: 400, at: NOW - OBSERVATION_MAX_AGE_MS - 1 },
        },
      },
      {
        id: '57.7009,11.9946',
        name: 'Göteborg Gårda',
        lat: 57.7009,
        lon: 11.9946,
        pollutants: { 'PM2.5': { value: 4, at: NOW - 2 * 60 * 60_000 } },
      },
      { id: 'x', name: 'Bara gamla', lat: 60, lon: 15, pollutants: {} },
    ],
    NOW,
  );
  assert.equal(rows.length, 2);
  const [worst, clean] = rows;
  assert.equal(worst.id, 'smhi:59.3400,18.0570');
  assert.equal(worst.provider, 'smhi');
  assert.equal(worst.scale, 'EAQI');
  assert.equal(worst.value, 3, 'NO2 95 µg/m³ is EAQI 3, O3 is too old');
  assert.equal(worst.band, 'moderate');
  assert.equal(worst.zone, 'se');
  assert.equal(worst.note, 'NO2 95.2 · PM10 12 µg/m³');
  assert.equal(worst.observedMs, NOW - 60 * 60_000);
  assert.equal(clean.value, 1);
  assert.equal(clean.band, 'low');
});

test('the SMHI source reads the proxy and rejects its warm-up answer', async () => {
  const urls = [];
  const source = createSmhiAirQualitySource({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        stations: [
          {
            id: 'a',
            name: 'Umeå Västra Esplanaden',
            lat: 63.82,
            lon: 20.26,
            pollutants: { NO2: { value: 20, at: NOW - 30 * 60_000 } },
          },
        ],
      });
    },
  });
  const [row] = await source.getSnapshot();
  assert.deepEqual(urls, ['/api/air-quality-se']);
  assert.equal(row.name, 'Umeå Västra Esplanaden');
  const warming = createSmhiAirQualitySource({
    fetchImpl: async () =>
      Response.json({ error: 'warming_up' }, { status: 503 }),
  });
  await assert.rejects(warming.getSnapshot(), /HTTP 503/);
  const malformed = createSmhiAirQualitySource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
});

test('the combined source keeps one network when the other fails', async () => {
  const ok = (rows) => ({ getSnapshot: async () => rows });
  const down = { getSnapshot: async () => Promise.reject(new Error('down')) };
  assert.deepEqual(
    await createCombinedAirQualitySource([ok([1]), ok([2, 3])]).getSnapshot(),
    [1, 2, 3],
  );
  assert.deepEqual(
    await createCombinedAirQualitySource([down, ok([2])]).getSnapshot(),
    [2],
  );
  await assert.rejects(
    createCombinedAirQualitySource([down, down]).getSnapshot(),
    /down/,
  );
});

test('the readout names every network behind the readings', async () => {
  const reading = (provider, scale, id) => ({
    id: `${provider}:${id}`,
    provider,
    scale,
    value: 2,
    band: 'low',
    stationId: id,
    name: id,
    zone: provider === 'smhi' ? 'se' : 'ont',
    lat: provider === 'smhi' ? 59.3 : 43.6,
    lon: provider === 'smhi' ? 18 : -79.4,
    observedMs: Date.now() - 60_000,
    color: '#4cc9f0',
    label: '2',
    risk: 'Low health risk',
    note: null,
  });
  let rows = [reading('smhi', 'EAQI', 'Stockholm')];
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  await layer.update();
  let summary = layer.getRowControls().summary;
  assert.match(summary.coverage, /SMHI/);
  assert.equal(summary.units, 'EAQI');
  rows = [...rows, reading('eccc', 'AQHI', 'Toronto')];
  await layer.update();
  summary = layer.getRowControls().summary;
  assert.match(summary.coverage, /Canada .* and Sweden/);
  assert.equal(summary.units, 'AQHI / EAQI');
  assert.match(
    summary.detail,
    /Environment and Climate Change Canada · AQHI · SMHI/,
  );
  layer.disable();
});
