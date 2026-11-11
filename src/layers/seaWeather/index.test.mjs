// The sea weather layer's life: failed drawings, a clean switch-off, a card
// that follows the newest values and the layer's own clock, and water levels
// that are only compared when they share a zero.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEA_WEATHER_OVERLAY_SOURCE_ID,
  createSeaWeatherLayer,
} from './index.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const HOUR = 3_600_000;
const LABELS = 'sea-weather-labels';

const station = (id, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [11.6 + Number(id) / 100, 57.63],
  meanWind: 6.7,
  gust: 7.4,
  windHeading: 243,
  level: -18,
  levelReference: 'MVY',
  waterTemp: 10.1,
  airTemp: null,
  waveHeight: null,
  visibility: null,
  updated: NOW - HOUR,
  ...extra,
});

function harness(t, stations = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {
    sources: [],
    picked: undefined,
    dataSources: {
      add: (source) => viewer.sources.push(source),
      remove() {},
    },
    scene: { pick: () => viewer.picked, requestRender() {} },
  };
  const feed = { stations, error: null, source: null };
  const clock = { now: NOW };
  const state = { shown: new Map(), click: null };
  const layer = createSeaWeatherLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stations: feed.stations,
          stale: false,
          fetchedAt: clock.now,
          ...(feed.source ? { source: feed.source } : {}),
        };
      },
    },
    overlayHost: {
      setEntries: (sourceId, entries) => state.shown.set(sourceId, entries),
      clearSource: (sourceId) => state.shown.delete(sourceId),
      setVisible() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const entities = viewer.sources[0].entities;
  const card = () => state.shown.get(SEA_WEATHER_OVERLAY_SOURCE_ID)?.[0];
  const labels = () => state.shown.get(LABELS) ?? [];
  const chip = (id) =>
    layer.getRowControls().chips.find((entry) => entry.id === id);
  return {
    layer,
    viewer,
    feed,
    clock,
    state,
    warn,
    entities,
    card,
    labels,
    chip,
  };
}

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [station('7'), station('8')]);
  layer.enable();
  t.mock.method(
    entities,
    'add',
    () => {
      throw new Error('no room');
    },
    { times: 1 },
  );
  await layer.update();
  assert.equal(layer.getStats().error, 'no room');
  assert.equal(
    warn.mock.calls.at(-1).arguments[0],
    '[Data:SeaWeather] Draw error:',
  );
  // The same values ten minutes on: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.equal(entities.values.length, 2);
  layer.destroy();
});

test('turning the layer off clears its error', async (t) => {
  const { layer, feed } = harness(t);
  layer.enable();
  feed.error = new Error('down');
  await layer.update();
  assert.equal(layer.getStats().error, 'down');
  layer.disable();
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});

test('the open card follows the newest values without a new drawing', async (t) => {
  const { layer, viewer, feed, clock, state, entities, card } = harness(t, [
    station('7'),
  ]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  viewer.picked = { id: entities.values[0].id };
  state.click({ position: { x: 10, y: 20 } });
  assert.deepEqual(card().details.slice(-2), [
    'Water +10.1 °C',
    'Measured 14:00 · Sjöfartsverket ViVa',
  ]);
  // Wind and level as before, a new water temperature and time: the dot is
  // left alone, the card reads the new row.
  const add = t.mock.method(entities, 'add');
  clock.now += 10 * 60_000;
  feed.stations = [station('7', { waterTemp: 9.8, updated: clock.now })];
  await layer.update();
  assert.equal(add.mock.calls.length, 0);
  assert.deepEqual(card().details.slice(-2), [
    'Water +9.8 °C',
    'Measured 15:10 · Sjöfartsverket ViVa',
  ]);
  // The station goes silent; the next day the reading carries its date.
  clock.now += 24 * HOUR;
  state.click({ position: { x: 10, y: 20 } });
  assert.equal(
    card().details.at(-1),
    'Measured 2026-11-05 15:10 · Sjöfartsverket ViVa',
  );
  layer.destroy();
});

test('in water level mode only levels against mean water are shown as such', async (t) => {
  const { layer, entities, labels, chip } = harness(t, [
    station('7', { level: 12 }),
    station('8', { level: 48, levelReference: 'Sjökortsnivå' }),
    station('9', { level: 74, levelReference: 'RH2000' }),
  ]);
  layer.enable();
  await layer.update();
  chip('level').onClick();
  // Vänern's 48 cm above chart datum is neither labelled nor "very high".
  assert.deepEqual(
    labels().map((entry) => [entry.id, entry.title]),
    [['sea-weather-label:7', '+12 cm']],
  );
  assert.deepEqual(
    layer.getRowControls().legend.map((item) => item.count),
    [1],
  );
  const grey = entities.values
    .filter((entity) => entity.point.pixelSize.getValue() === 6)
    .map((entity) => entity.id);
  assert.deepEqual(grey, ['se-viva:8', 'se-viva:9']);
  layer.destroy();
});

test('stations from SMHI, without wind, are coloured by water level and credit SMHI', async (t) => {
  const { layer, feed, chip } = harness(t, [station('1'), station('2')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.source, 'Sjöfartsverket');
  assert.equal(chip('wind')?.active, true);
  feed.source = 'smhi';
  feed.stations = [
    station('3', { meanWind: null, gust: null, windHeading: null }),
    station('4', { meanWind: null, gust: null, windHeading: null }),
  ];
  await layer.update();
  assert.equal(layer.source, 'SMHI');
  assert.equal(chip('wind'), undefined);
  assert.equal(chip('level').active, true);
  assert.match(
    layer.getRowControls().legend[0].blurb,
    /SMHI’s ocean stations/,
  );
  layer.destroy();
});
