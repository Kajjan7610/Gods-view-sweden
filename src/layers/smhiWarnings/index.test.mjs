// The warnings layer's life: failed drawings, a clean switch-off, its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSmhiWarningsLayer } from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00Z');
const MINUTE = 60_000;

const area = (id, extra = {}) => ({
  id,
  level: 'YELLOW',
  event: { sv: 'Vind', en: 'Wind' },
  eventCode: 'WIND',
  description: null,
  area: { sv: 'Fjälltrakterna', en: 'The mountain regions' },
  counties: [],
  start: NOW - 60 * MINUTE,
  end: NOW + 600 * MINUTE,
  upcoming: false,
  published: NOW - 120 * MINUTE,
  texts: [],
  polygons: [
    {
      outer: [
        [18, 67],
        [19, 67],
        [19, 68],
      ],
      holes: [],
    },
  ],
  ...extra,
});

/** A layer on a fake viewer, fed by `feed.areas` (or failing on `feed.error`). */
function harness(t, areas = []) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const sources = [];
  const viewer = {
    dataSources: { add: (source) => sources.push(source), remove() {} },
    scene: { requestRender() {} },
  };
  const feed = { areas, crisis: [], error: null, stale: false, fetchedAt: NOW };
  const clock = { now: NOW };
  const layer = createSmhiWarningsLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          areas: feed.areas,
          crisis: feed.crisis,
          stale: feed.stale,
          fetchedAt: feed.fetchedAt,
        };
      },
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  const drawn = () => sources[0].entities.values.map((entity) => entity.id);
  return { layer, feed, clock, warn, drawn, entities: sources[0].entities };
}

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, drawn, entities } = harness(t, [area('1:1')]);
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
    '[Data:SmhiWarnings] Draw error:',
  );
  // The same warnings at the next refresh: drawn all the same, error gone.
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(drawn(), ['se-smhiwarn:1:1:fill0', 'se-smhiwarn:1:1:edge0']);
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
  const { layer, feed, clock } = harness(t, [area('1:1')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  // A stale snapshot is as old as the read it came from.
  clock.now += 10 * MINUTE;
  feed.stale = true;
  feed.fetchedAt = NOW + MINUTE;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + MINUTE);
  assert.equal(layer.getStats().stale, true);
  layer.destroy();
});
