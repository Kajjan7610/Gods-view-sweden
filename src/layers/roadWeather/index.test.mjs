// The road weather layer's life: fading while the data stands still, failed
// drawings, a clean switch-off and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createTrafikverketWeatherLayer } from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;

const station = (id, minutesAgo, extra = {}) => ({
  id,
  name: `Station ${id}`,
  point: [18.04, 59.38],
  sampled: NOW - minutesAgo * MINUTE,
  surfaceTemp: -0.6,
  airTemp: 0.2,
  dewpoint: -1,
  humidity: 90,
  visibility: null,
  windSpeed: null,
  windDirection: null,
  windGust: null,
  precipitation: 'no',
  precipitation30: null,
  surfaceIce: null,
  surfaceSnow: null,
  surfaceWater: null,
  grip: null,
  risk: null,
  ...extra,
});

/** A layer on a fake viewer, fed by `feed.stations` (or failing on `feed.error`). */
function harness(t, stations = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const sources = [];
  const viewer = {
    dataSources: { add: (source) => sources.push(source), remove() {} },
    scene: { requestRender() {} },
  };
  const feed = { stations, error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const layer = createTrafikverketWeatherLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          stations: feed.stations,
          stale: feed.stale,
          fetchedAt: feed.fetchedAt,
        };
      },
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const entities = sources[0].entities;
  return { layer, feed, clock, warn, entities };
}

const alphaOf = (entities, id) =>
  entities.getById(id).point.color.getValue(Cesium.JulianDate.now()).alpha;

test('a station fades when it passes the hour, also while the data stands still', async (t) => {
  const { layer, feed, clock, entities } = harness(t, [
    station('a', 50),
    station('b', 5),
  ]);
  layer.enable();
  await layer.update();
  const id = entities.values[0].id;
  assert.ok(id.endsWith(':a'), id);
  assert.equal(alphaOf(entities, id), 1);
  // An outage: the proxy serves the same snapshot, a quarter of an hour on.
  clock.now += 15 * MINUTE;
  feed.stale = true;
  await layer.update();
  assert.equal(alphaOf(entities, id), 0.45);
  assert.equal(alphaOf(entities, entities.values[1].id), 1);
  // Nothing passes the hour in the next minute: nothing is drawn again.
  const kept = entities.values[0];
  clock.now += MINUTE;
  await layer.update();
  assert.equal(entities.values[0], kept);
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, entities } = harness(t, [
    station('a', 5),
    station('b', 5),
  ]);
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
    '[Data:TrafikverketWeather] Draw error:',
  );
  // The same readings at the next refresh: drawn all the same, error gone.
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

test('the time of the last update follows the injected clock', async (t) => {
  const { layer, feed, clock } = harness(t, [station('a', 5)]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  // A stale snapshot is as old as the read it came from.
  clock.now += 10 * MINUTE;
  feed.stale = true;
  feed.fetchedAt = NOW + MINUTE;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + MINUTE);
  layer.destroy();
});
