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
import { setLocale } from '../../i18n/index.js';
import { buildStationCard, createAirQualityLayer } from './index.js';

const NOW = Date.parse('2026-11-04T22:00:00Z');

test('EAQI levels follow the limits the EEA lists today', () => {
  // The EEA's table (airindex.eea.europa.eu, read 2026-11-10): the last
  // value of each level and the first of the next.
  const table = {
    'PM2.5': [5, 15, 50, 90, 140],
    PM10: [15, 45, 120, 195, 270],
    O3: [60, 100, 120, 160, 180],
    NO2: [10, 25, 60, 100, 150],
  };
  for (const [pollutant, limits] of Object.entries(table)) {
    assert.equal(eaqiLevel(pollutant, 0), 1, pollutant);
    limits.forEach((limit, index) => {
      assert.equal(eaqiLevel(pollutant, limit), index + 1, pollutant);
      assert.equal(eaqiLevel(pollutant, limit + 1), index + 2, pollutant);
    });
  }
  // Two stations as they measured on 2026-11-10.
  assert.equal(eaqiLevel('NO2', 59.3), 3, 'Malmö Dalaplan: moderate');
  assert.equal(eaqiLevel('PM10', 121.9), 4, 'Piteå Hamnplan: poor');
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
  assert.equal(worst.value, 4, 'NO2 95 µg/m³ is EAQI 4, O3 is too old');
  assert.equal(worst.band, 'high');
  assert.deepEqual(worst.measurements, [
    { pollutant: 'NO2', value: 95.2 },
    { pollutant: 'PM10', value: 12 },
  ]);
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

test('a network that failed is named beside the readings of the other', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const reading = {
    id: 'eccc:A',
    provider: 'eccc',
    scale: 'AQHI',
    value: 2,
    band: 'low',
    stationId: 'A',
    name: 'Toronto',
    zone: 'ont',
    lat: 43.65,
    lon: -79.38,
    observedMs: Date.now() - 60_000,
    color: '#4cc9f0',
    label: '2',
    risk: 'Low health risk',
    note: null,
  };
  const state = { smhiDown: true };
  const source = createCombinedAirQualitySource([
    { getSnapshot: async () => [reading] },
    {
      getSnapshot: async () => {
        if (state.smhiDown) throw new Error('SMHI air quality HTTP 503');
        return [{ ...reading, id: 'smhi:B', provider: 'smhi', scale: 'EAQI' }];
      },
    },
  ]);
  // The source: Canada's readings, and the failure beside them.
  const partial = await source.getSnapshot();
  assert.deepEqual(partial, [reading]);
  assert.deepEqual(
    partial.failures.map((error) => error.message),
    ['SMHI air quality HTTP 503'],
  );
  // The layer: the stations it has, and an error naming the missing network.
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, 'SMHI air quality HTTP 503');
  assert.equal(
    layer.getRowControls().summary.status,
    'SMHI air quality HTTP 503',
  );
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:AirQuality] A network failed:',
  );
  // SMHI answers again: both networks, no error.
  state.smhiDown = false;
  const whole = await source.getSnapshot();
  assert.equal(whole.failures, undefined);
  await layer.update();
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().error, null);
  layer.disable();
});

test('the card writes the measurements in the app’s number format', () => {
  const [row] = normalizeSmhiReadings(
    [
      {
        id: '65.3170,21.4790',
        name: 'Piteå Hamnplan 60',
        lat: 65.317,
        lon: 21.479,
        pollutants: {
          PM10: { value: 121.94, at: NOW - 60 * 60_000 },
          NO2: { value: 59.3, at: NOW - 60 * 60_000 },
        },
      },
    ],
    NOW,
  );
  // The reading itself stays plain data.
  assert.equal(row.note, 'PM10 121.9 · NO2 59.3 µg/m³');
  assert.equal(buildStationCard(row).details[1], 'PM10 121.9 · NO2 59.3 µg/m³');
  setLocale('sv');
  try {
    assert.equal(
      buildStationCard(row).details[1],
      'PM10 121,9 · NO2 59,3 µg/m³',
    );
  } finally {
    setLocale('en');
  }
  // A network with a note of its own keeps it.
  assert.equal(
    buildStationCard({ ...row, measurements: undefined, note: 'As given' })
      .details[1],
    'As given',
  );
});
