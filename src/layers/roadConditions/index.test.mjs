// The road layer's life: the map changes in place, cards read the newest
// rows, failed drawings, a clean switch-off and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROAD_OVERLAY_SOURCE_ID,
  createTrafikverketRoadsLayer,
} from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;
const PICK = 'se-road:';

const condition = (id, code = 2, extra = {}) => ({
  id,
  code,
  text: code === 1 ? 'Normalt' : 'Besvärligt (risk för)',
  info: [],
  warnings: [],
  measures: [],
  causes: [],
  road: 'E4',
  location: null,
  start: null,
  end: null,
  lines: [
    [
      [18, 59],
      [18.1, 59.1],
    ],
  ],
  ...extra,
});

const incident = (id, extra = {}) => ({
  id,
  kind: 'roadwork',
  type: 'Vägarbete',
  code: null,
  header: 'Beläggningsarbete',
  message: 'Ett körfält avstängt',
  severity: 2,
  severityText: null,
  road: 'E4',
  location: null,
  restriction: null,
  start: null,
  end: null,
  untilFurtherNotice: true,
  link: null,
  point: [18, 59],
  lines: [],
  ...extra,
});

/** A layer on a fake viewer, fed by `feed` (or failing on `feed.error`). */
function harness(t, conditions = [], incidents = []) {
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
  const feed = { conditions, incidents, error: null, stale: false };
  const clock = { now: NOW };
  const state = { cards: [], click: null };
  const layer = createTrafikverketRoadsLayer({
    source: {
      getSnapshot: async () => {
        if (feed.error) throw feed.error;
        return {
          conditions: feed.conditions,
          incidents: feed.incidents,
          stale: feed.stale,
          fetchedAt: NOW,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, ROAD_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
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
  const events = [];
  const short = (list) => list.map((entity) => entity.id.slice(PICK.length));
  entities.collectionChanged.addEventListener(
    (collection, added, removed, changed) =>
      events.push({
        added: short(added),
        removed: short(removed),
        changed: short(changed),
      }),
  );
  const drawn = () => short(entities.values);
  const select = (id) => {
    viewer.picked = { id: `${PICK}${id}` };
    state.click({ position: { x: 10, y: 20 } });
  };
  const chip = (id) =>
    layer
      .getRowControls()
      .chips.find((entry) => entry.id === id)
      .onClick();
  return {
    layer,
    feed,
    clock,
    state,
    warn,
    entities,
    events,
    drawn,
    select,
    chip,
  };
}

test('a refresh changes the map in place: only new, gone and changed rows are touched', async (t) => {
  const { layer, feed, entities, events, drawn } = harness(
    t,
    [condition('c1')],
    [incident('a'), incident('b', { point: [17, 58] })],
  );
  layer.enable();
  await layer.update();
  assert.deepEqual(drawn(), ['c:c1:0', 'i:a:point', 'i:b:point']);
  const kept = new Map(entities.values.map((entity) => [entity.id, entity]));
  events.length = 0;

  // One incident is over and one is new; the rest are as they were, though
  // every row is a new object, as after each fetch.
  feed.conditions = [condition('c1')];
  feed.incidents = [incident('a'), incident('n', { point: [16, 57] })];
  await layer.update();
  assert.deepEqual(events, [
    { added: [], removed: ['i:b:point'], changed: [] },
    { added: ['i:n:point'], removed: [], changed: [] },
  ]);
  assert.equal(entities.getById(`${PICK}c:c1:0`), kept.get(`${PICK}c:c1:0`));
  assert.equal(
    entities.getById(`${PICK}i:a:point`),
    kept.get(`${PICK}i:a:point`),
  );

  // A row that changed is drawn anew: a new place, a new kind, a new stretch.
  events.length = 0;
  feed.conditions = [
    condition('c1', 3, {
      lines: [
        [
          [18, 59],
          [18.2, 59.2],
        ],
      ],
    }),
  ];
  feed.incidents = [
    incident('a', { point: [18.5, 59.5] }),
    incident('n', { point: [16, 57] }),
  ];
  await layer.update();
  assert.deepEqual(events, [
    { added: [], removed: ['c:c1:0', 'i:a:point'], changed: [] },
    { added: ['c:c1:0', 'i:a:point'], removed: [], changed: [] },
  ]);
  assert.notEqual(entities.getById(`${PICK}c:c1:0`), kept.get(`${PICK}c:c1:0`));
  assert.equal(layer.getStats().incidents, 2);

  // A refresh with nothing new touches nothing at all.
  events.length = 0;
  await layer.update();
  assert.deepEqual(events, []);
  layer.destroy();
});

test('a card reads the newest text even when nothing on the map changed', async (t) => {
  const { layer, feed, state, events, select } = harness(
    t,
    [],
    [incident('a')],
  );
  layer.enable();
  await layer.update();
  select('i:a:point');
  assert.ok(state.cards[0].details.includes('Ett körfält avstängt'));
  events.length = 0;
  feed.incidents = [incident('a', { message: 'Vägen helt avstängd' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Vägen helt avstängd'));
  assert.deepEqual(events, [], 'the dot itself is left alone');
  layer.destroy();
});

test('the toggles add and remove their own rows and leave the rest alone', async (t) => {
  const { layer, entities, events, drawn, chip } = harness(
    t,
    [condition('c1'), condition('ok', 1)],
    [incident('a'), incident('m', { kind: 'minor' })],
  );
  layer.enable();
  await layer.update();
  // Normal stretches and minor notices are hidden until asked for.
  assert.deepEqual(drawn(), ['c:c1:0', 'i:a:point']);
  const stretch = entities.getById(`${PICK}c:c1:0`);
  const dot = entities.getById(`${PICK}i:a:point`);
  events.length = 0;
  chip('normal');
  chip('minor');
  assert.deepEqual(events, [
    { added: ['c:ok:0'], removed: [], changed: [] },
    { added: ['i:m:point'], removed: [], changed: [] },
  ]);
  events.length = 0;
  chip('incidents');
  assert.deepEqual(events, [
    { added: [], removed: ['i:a:point', 'i:m:point'], changed: [] },
  ]);
  assert.equal(entities.getById(`${PICK}c:c1:0`), stretch);
  chip('incidents');
  assert.notEqual(entities.getById(`${PICK}i:a:point`), dot);
  assert.deepEqual(drawn().sort(), [
    'c:c1:0',
    'c:ok:0',
    'i:a:point',
    'i:m:point',
  ]);
  layer.destroy();
});

test('a selected row that leaves the map loses its card', async (t) => {
  const { layer, feed, state, select, chip } = harness(
    t,
    [],
    [incident('a'), incident('m', { kind: 'minor' })],
  );
  layer.enable();
  await layer.update();
  // Hidden by a toggle.
  chip('minor');
  select('i:m:point');
  assert.equal(state.cards.length, 1);
  chip('minor');
  assert.deepEqual(state.cards, []);
  // Over, according to Trafikverket.
  select('i:a:point');
  assert.equal(state.cards.length, 1);
  feed.incidents = [incident('m', { kind: 'minor' })];
  await layer.update();
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('a drawing that failed is reported as one, and made again from scratch', async (t) => {
  const { layer, feed, warn, entities, drawn } = harness(
    t,
    [condition('c1')],
    [incident('a')],
  );
  layer.enable();
  await layer.update();
  const before = entities.getById(`${PICK}c:c1:0`);
  // A refresh in place fails halfway: not trusted, the next one starts over.
  feed.incidents = [incident('a'), incident('n', { point: [16, 57] })];
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
    '[Data:TrafikverketRoads] Draw error:',
  );
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(drawn(), ['c:c1:0', 'i:a:point', 'i:n:point']);
  assert.notEqual(entities.getById(`${PICK}c:c1:0`), before, 'drawn again');
  // And the refresh after that is in place again.
  const kept = entities.getById(`${PICK}c:c1:0`);
  await layer.update();
  assert.equal(entities.getById(`${PICK}c:c1:0`), kept);
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
  const { layer, clock } = harness(t, [condition('c1')]);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW);
  clock.now += 3 * MINUTE;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, NOW + 3 * MINUTE);
  layer.destroy();
});
