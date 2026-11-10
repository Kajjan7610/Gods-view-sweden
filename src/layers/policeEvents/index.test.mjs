// The police events layer's life: failed drawings, a clean switch-off, its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createPolisenEventsLayer } from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00Z');
const HOUR = 60 * 60_000;
const PICK = 'se-polisen:';

const notice = (id, hoursAgo, extra = {}) => ({
  id,
  time: NOW - hoursAgo * HOUR,
  type: 'Trafikolycka',
  category: 'traffic',
  title: `4 november, Trafikolycka, Göteborg`,
  summary: null,
  place: 'Göteborg',
  county: 'Västra Götalands län',
  precision: 'municipality',
  point: [11.9675, 57.7075],
  link: null,
  ...extra,
});

/** A layer on a fake viewer, fed by `feed.events` (or failing on `feed.error`). */
function harness(t, events = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const sources = [];
  const viewer = {
    dataSources: { add: (source) => sources.push(source), remove() {} },
    scene: { requestRender() {} },
  };
  const feed = { events, error: null };
  const clock = { now: NOW };
  const layer = createPolisenEventsLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return { events: feed.events, stale: false, fetchedAt: clock.now };
      },
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const markers = () => sources[0].entities.values;
  return { layer, feed, clock, warn, markers, entities: sources[0].entities };
}

const ids = (list) => list.map((marker) => marker.id.slice(PICK.length));
const sizeOf = (marker) =>
  marker.point.pixelSize.getValue(Cesium.JulianDate.now());

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, markers, entities } = harness(t, [
    notice('a', 1),
    notice('b', 2),
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
    '[Data:PolisenEvents] Draw error:',
  );
  // The same notices at the next refresh: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(ids(markers()), ['b', 'a']);
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

test("the time window and the bright dots follow the layer's own clock", async (t) => {
  const { layer, clock, markers } = harness(t, [
    notice('new', 1),
    notice('old', 30),
  ]);
  layer.enable();
  await layer.update();
  // Last 24 hours: the 30-hour-old notice is left out; a 1-hour-old one is bright.
  assert.deepEqual(ids(markers()), ['new']);
  assert.equal(sizeOf(markers()[0]), 10);
  assert.equal(layer.getStats().lastUpdate, NOW);
  // Three hours on, the notice is no longer fresh.
  clock.now += 3 * HOUR;
  await layer.update();
  assert.equal(sizeOf(markers()[0]), 8);
  assert.equal(layer.getStats().lastUpdate, NOW + 3 * HOUR);
  // A day on, it has left the window too.
  clock.now += 21 * HOUR;
  await layer.update();
  assert.deepEqual(ids(markers()), []);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().notices, 2);
  layer.destroy();
});
