// The road layer's life: three sets (condition stretches, incident stretches,
// incident dots) shown only while the layer is on, the map changing in place,
// cards that read the newest rows, clicks, ground heights, failed drawings, a
// clean switch-off and its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  ROAD_CONDITION_LINES_SET_ID,
  ROAD_INCIDENT_DOTS_SET_ID,
  ROAD_INCIDENT_LINES_SET_ID,
  ROAD_OVERLAY_SOURCE_ID,
  conditionColor,
  createTrafikverketRoadsLayer,
  incidentColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00+01:00');
const MINUTE = 60_000;
const PICK = 'se-road:';
const LINK = 'https://www.trafikverket.se/trafikinformation/vag/a';
/** Each set by a short name, for the writes a test expects. */
const SHORT = Object.freeze({
  [ROAD_CONDITION_LINES_SET_ID]: 'conditions',
  [ROAD_INCIDENT_LINES_SET_ID]: 'incidentLines',
  [ROAD_INCIDENT_DOTS_SET_ID]: 'dots',
});

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
function harness(t, conditions = [], incidents = [], options = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // Every write to a set, in order: "<set>.<op>" and the ids it names.
  const writes = [];
  const made = new Map();
  const short = (id) => id.slice(PICK.length);
  for (const kind of ['lines', 'points']) {
    const make = draw[kind];
    draw[kind] = (spec) => {
      const set = make(spec);
      const name = SHORT[spec.id];
      made.set(name, set);
      for (const op of ['set', 'upsert']) {
        const write = set[op];
        set[op] = (items) => {
          write(items);
          writes.push([`${name}.${op}`, items.map((item) => short(item.id))]);
        };
      }
      const remove = set.remove;
      set.remove = (ids) => {
        remove(ids);
        writes.push([`${name}.remove`, ids.map(short)]);
      };
      return set;
    };
  }
  const feed = { conditions, incidents, error: null, stale: false };
  const clock = { now: NOW };
  const state = { cards: [], clicks: [], cardHit: null, opened: [] };
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
      hitTest: () => state.cardHit,
    },
    // The globe's clicks: one listener per click handler installed.
    input: () => ({
      onClick(callback) {
        const handler = { callback, off: false };
        state.clicks.push(handler);
        return () => {
          handler.off = true;
        };
      },
    }),
    picking,
    openExternal: (url) => state.opened.push(url),
    now: () => clock.now,
    ...options,
  });
  layer.init(viewer);
  const setOf = (id) => draw.set(id);
  const ids = (id) =>
    [...(setOf(id)?.items.keys() ?? [])].map((key) => key.slice(PICK.length));
  const drawn = () => ({
    conditions: ids(ROAD_CONDITION_LINES_SET_ID),
    incidentLines: ids(ROAD_INCIDENT_LINES_SET_ID),
    dots: ids(ROAD_INCIDENT_DOTS_SET_ID),
  });
  const item = (setId, id) => setOf(setId)?.items.get(`${PICK}${id}`);
  const click = (pickId = null) =>
    state.clicks.at(-1).callback({
      screenPosition: { x: 10, y: 20 },
      topHit: pickId ? { set: 'some-set', id: pickId, surface: false } : null,
    });
  const select = (id) => click(`${PICK}${id}`);
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
    draw,
    made,
    writes,
    setOf,
    drawn,
    item,
    click,
    select,
    chip,
  };
}

test('the roads are three sets, shown only while the layer is on', async (t) => {
  const { layer, setOf, drawn, state } = harness(
    t,
    [condition('c1')],
    [
      incident('a', {
        lines: [
          [
            [18, 59],
            [18.2, 59.2],
          ],
        ],
      }),
    ],
  );
  const sets = [
    ROAD_CONDITION_LINES_SET_ID,
    ROAD_INCIDENT_LINES_SET_ID,
    ROAD_INCIDENT_DOTS_SET_ID,
  ];
  for (const id of sets) assert.equal(setOf(id).show, false, id);
  layer.enable();
  for (const id of sets) assert.equal(setOf(id).show, true, id);
  assert.equal(await layer.update(), true);
  assert.deepEqual(drawn(), {
    conditions: ['c:c1:0'],
    incidentLines: ['i:a:line0'],
    dots: ['i:a:point'],
  });
  layer.disable();
  for (const id of sets) assert.equal(setOf(id).show, false, id);
  assert.equal(state.clicks[0].off, true);
  layer.destroy();
  for (const id of sets) assert.equal(setOf(id), undefined, `${id} disposed`);
});

test('road lines drape on every surface; the dots clamp to terrain only once they have ground heights', (t) => {
  const plain = harness(t);
  assert.equal(plain.setOf(ROAD_CONDITION_LINES_SET_ID).spec.clampTo, 'both');
  assert.equal(plain.setOf(ROAD_INCIDENT_LINES_SET_ID).spec.clampTo, 'both');
  assert.equal(plain.setOf(ROAD_INCIDENT_DOTS_SET_ID).spec.clampTo, 'both');
  assert.equal(plain.setOf(ROAD_INCIDENT_DOTS_SET_ID).spec.horizonCull, true);
  const terrain = { resolveEllipsoidalGround: async () => [] };
  const lifted = harness(t, [], [], { terrain });
  assert.equal(lifted.setOf(ROAD_CONDITION_LINES_SET_ID).spec.clampTo, 'both');
  assert.equal(lifted.setOf(ROAD_INCIDENT_DOTS_SET_ID).spec.clampTo, 'terrain');
});

test('a stretch of road condition is a solid draped line, coloured and sized by its code', async (t) => {
  const { layer, item, chip } = harness(t, [
    condition('hard', 3),
    condition('ok', 1),
  ]);
  layer.enable();
  await layer.update();
  chip('normal');
  const hard = item(ROAD_CONDITION_LINES_SET_ID, 'c:hard:0');
  assert.equal(hard.mode, 'draped');
  assert.equal(hard.widthPx, 6);
  assert.equal(hard.style.kind, 'solid');
  assert.deepEqual(hard.style.color, [
    ...cssColor(conditionColor(3)).slice(0, 3),
    0.9,
  ]);
  assert.deepEqual(hard.positions, [
    fromDegrees(18, 59),
    fromDegrees(18.1, 59.1),
  ]);
  // Normal stretches are thin and paler.
  const ok = item(ROAD_CONDITION_LINES_SET_ID, 'c:ok:0');
  assert.equal(ok.widthPx, 2);
  assert.deepEqual(ok.style.color, [
    ...cssColor(conditionColor(1)).slice(0, 3),
    0.55,
  ]);
  layer.destroy();
});

test('an incident is a dashed draped stretch and a dot sized by severity; a closure is ringed red', async (t) => {
  const stretch = [
    [
      [18, 59],
      [18.2, 59.2],
    ],
  ];
  const { layer, item } = harness(
    t,
    [],
    [
      incident('work', { lines: stretch }),
      incident('shut', { kind: 'closure', severity: 5, lines: stretch }),
      incident('small', { kind: 'minor', severity: 4 }),
    ],
  );
  layer.enable();
  await layer.update();
  const line = item(ROAD_INCIDENT_LINES_SET_ID, 'i:work:line0');
  assert.equal(line.mode, 'draped');
  assert.equal(line.widthPx, 3);
  assert.deepEqual(line.style, {
    kind: 'dash',
    color: [...cssColor(incidentColor('roadwork')).slice(0, 3), 0.8],
    length: 14,
  });
  const shutLine = item(ROAD_INCIDENT_LINES_SET_ID, 'i:shut:line0');
  assert.equal(shutLine.widthPx, 4);
  assert.deepEqual(shutLine.style.color, [
    ...cssColor('#ff1744').slice(0, 3),
    0.8,
  ]);

  const dot = item(ROAD_INCIDENT_DOTS_SET_ID, 'i:work:point');
  assert.equal(dot.pixelSize, 10);
  assert.equal(dot.color, incidentColor('roadwork'));
  assert.deepEqual(dot.outlineColor, [0, 0, 0, 0.8]);
  assert.equal(dot.outlineWidth, 1.5);
  assert.equal(dot.height, 'clampGround');
  assert.deepEqual(dot.pos, { lon: 18, lat: 59, height: 0 });
  assert.equal(dot.disableDepthTest, Number.POSITIVE_INFINITY);
  const shut = item(ROAD_INCIDENT_DOTS_SET_ID, 'i:shut:point');
  assert.equal(shut.pixelSize, 15);
  assert.equal(shut.color, incidentColor('closure'));
  assert.equal(shut.outlineColor, '#ff1744');
  assert.equal(shut.outlineWidth, 3);
  // Minor notices are hidden until asked for, then small whatever their
  // severity.
  assert.equal(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:small:point'), undefined);
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'minor')
    .onClick();
  assert.equal(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:small:point').pixelSize, 6);
  layer.destroy();
});

test('a refresh changes the map in place: only new, gone and changed rows are touched', async (t) => {
  const { layer, feed, writes, drawn, item } = harness(
    t,
    [condition('c1')],
    [incident('a'), incident('b', { point: [17, 58] })],
  );
  layer.enable();
  await layer.update();
  assert.deepEqual(drawn(), {
    conditions: ['c:c1:0'],
    incidentLines: [],
    dots: ['i:a:point', 'i:b:point'],
  });
  const keptLine = item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0');
  const keptDot = item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point');
  writes.length = 0;

  // One incident is over and one is new; the rest are as they were, though
  // every row is a new object, as after each fetch. The lines are not
  // written at all.
  feed.conditions = [condition('c1')];
  feed.incidents = [incident('a'), incident('n', { point: [16, 57] })];
  await layer.update();
  assert.deepEqual(writes, [
    ['dots.remove', ['i:b:point']],
    ['dots.upsert', ['i:n:point']],
  ]);
  assert.equal(item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0'), keptLine);
  assert.equal(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point'), keptDot);

  // A row that changed is drawn anew: a new place, a new kind, a new stretch.
  writes.length = 0;
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
  assert.deepEqual(writes, [
    ['dots.remove', ['i:a:point']],
    ['dots.upsert', ['i:a:point']],
    ['conditions.set', ['c:c1:0']],
  ]);
  assert.notEqual(item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0'), keptLine);
  assert.equal(item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0').widthPx, 6);
  assert.deepEqual(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point').pos, {
    lon: 18.5,
    lat: 59.5,
    height: 0,
  });
  assert.equal(layer.getStats().incidents, 2);

  // A refresh with nothing new touches nothing at all.
  writes.length = 0;
  await layer.update();
  assert.deepEqual(writes, []);
  layer.destroy();
});

test('a card reads the newest text even when nothing on the map changed', async (t) => {
  const { layer, feed, state, writes, select } = harness(
    t,
    [],
    [incident('a')],
  );
  layer.enable();
  await layer.update();
  select('i:a:point');
  assert.ok(state.cards[0].details.includes('Ett körfält avstängt'));
  writes.length = 0;
  feed.incidents = [incident('a', { message: 'Vägen helt avstängd' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Vägen helt avstängd'));
  assert.deepEqual(writes, [], 'the dot itself is left alone');
  layer.destroy();
});

test('the toggles add and remove their own rows and leave the rest alone', async (t) => {
  const { layer, writes, drawn, item, chip } = harness(
    t,
    [condition('c1'), condition('ok', 1)],
    [incident('a'), incident('m', { kind: 'minor' })],
  );
  layer.enable();
  await layer.update();
  // Normal stretches and minor notices are hidden until asked for.
  assert.deepEqual(drawn(), {
    conditions: ['c:c1:0'],
    incidentLines: [],
    dots: ['i:a:point'],
  });
  const dot = item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point');
  writes.length = 0;
  chip('normal');
  chip('minor');
  assert.deepEqual(writes, [
    ['conditions.set', ['c:c1:0', 'c:ok:0']],
    ['dots.upsert', ['i:m:point']],
  ]);
  writes.length = 0;
  chip('incidents');
  assert.deepEqual(writes, [['dots.remove', ['i:a:point', 'i:m:point']]]);
  assert.deepEqual(drawn().conditions, ['c:c1:0', 'c:ok:0']);
  writes.length = 0;
  chip('incidents');
  assert.deepEqual(writes, [['dots.upsert', ['i:a:point', 'i:m:point']]]);
  assert.notEqual(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point'), dot);
  assert.deepEqual(drawn(), {
    conditions: ['c:c1:0', 'c:ok:0'],
    incidentLines: [],
    dots: ['i:a:point', 'i:m:point'],
  });
  layer.destroy();
});

test('a click on a stretch or a dot opens its card; the ground closes it', async (t) => {
  const { layer, state, select, click } = harness(
    t,
    [condition('k', 3)],
    [
      incident('a', {
        link: LINK,
        lines: [
          [
            [18, 59],
            [18.2, 59.2],
          ],
        ],
      }),
    ],
  );
  layer.enable();
  await layer.update();
  select('c:k:0');
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['trafikverket-road-card:c:k'],
  );
  assert.deepEqual(state.cards[0].position, fromDegrees(18.1, 59.1, 0));
  // The incident's dashed stretch opens the incident.
  select('i:a:line0');
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['trafikverket-road-card:i:a'],
  );
  select('i:a:point');
  assert.deepEqual(state.cards[0].position, fromDegrees(18, 59, 0));
  // A click on its own card opens the incident's page and keeps it.
  state.cardHit = {
    sourceId: ROAD_OVERLAY_SOURCE_ID,
    entryId: state.cards[0].id,
  };
  click(`${PICK}c:k:0`);
  assert.deepEqual(state.opened, [LINK]);
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['trafikverket-road-card:i:a'],
  );
  state.cardHit = null;
  click();
  assert.deepEqual(state.cards, [], 'a click on the ground lets go');
  layer.destroy();
});

test("another layer's card or dot under a click leaves the selection", async (t) => {
  const { layer, state, select, click } = harness(t, [], [incident('a')]);
  layer.enable();
  await layer.update();
  select('i:a:point');
  // Another layer's card.
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  click();
  assert.equal(state.cards.length, 1);
  state.cardHit = null;
  // Another layer's dot.
  picking.registerPickOwner('other-layer', (id) => id.startsWith('other:'));
  t.after(() => picking.unregisterPickOwner('other-layer'));
  click('other:1');
  assert.equal(state.cards.length, 1);
  assert.deepEqual(state.opened, []);
  // The road layer itself owns no picks: long lines would make others' inert.
  assert.equal(picking.findPickOwner(`${PICK}i:a:point`), null);
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

test('ground heights move only the incident dots drawn, and the card with them', async (t) => {
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const terrain = {
    resolveEllipsoidalGround: async (points) => {
      await answered;
      return points.map(() => ({ ellipsoid: 42, source: 'reearth' }));
    },
  };
  const { layer, state, item, select, writes } = harness(
    t,
    [condition('c1')],
    [incident('a'), incident('m', { kind: 'minor', point: [17, 58] })],
    { terrain },
  );
  layer.enable();
  await layer.update();
  select('i:a:point');
  writes.length = 0;
  answer();
  for (
    let i = 0;
    i < 50 && item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point').pos.height !== 42;
    i += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(item(ROAD_INCIDENT_DOTS_SET_ID, 'i:a:point').pos.height, 42);
  assert.equal(
    item(ROAD_INCIDENT_DOTS_SET_ID, 'i:m:point'),
    undefined,
    'a hidden notice stays undrawn',
  );
  assert.ok(
    writes.every(([op]) => op === 'dots.upsert'),
    'only dots move',
  );
  assert.deepEqual(state.cards[0].position, fromDegrees(18, 59, 42));
  layer.destroy();
});

test('a drawing that failed is reported as one, and made again from scratch', async (t) => {
  const { layer, feed, warn, made, writes, drawn, item } = harness(
    t,
    [condition('c1')],
    [incident('a')],
  );
  layer.enable();
  await layer.update();
  const before = item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0');
  // A refresh in place fails halfway: not trusted, the next one starts over.
  feed.incidents = [incident('a'), incident('n', { point: [16, 57] })];
  t.mock.method(
    made.get('dots'),
    'upsert',
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
  writes.length = 0;
  await layer.update();
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(
    writes.map(([op]) => op),
    ['conditions.set', 'incidentLines.set', 'dots.set'],
    'drawn again, whole',
  );
  assert.deepEqual(drawn(), {
    conditions: ['c:c1:0'],
    incidentLines: [],
    dots: ['i:a:point', 'i:n:point'],
  });
  assert.notEqual(
    item(ROAD_CONDITION_LINES_SET_ID, 'c:c1:0'),
    before,
    'drawn again',
  );
  // And the refresh after that is in place again.
  writes.length = 0;
  await layer.update();
  assert.deepEqual(writes, []);
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
