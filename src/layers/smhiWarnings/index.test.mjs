// The warnings layer's life: three sets (area fills, area edges, crisis dots)
// shown only while the layer is on, how each is drawn, clicks, ground
// heights, failed drawings, a clean switch-off, its clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { cssColor } from '../../render/color.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  SMHI_CRISIS_DOTS_SET_ID,
  SMHI_WARNINGS_OVERLAY_SOURCE_ID,
  SMHI_WARNINGS_PAGE,
  SMHI_WARNING_EDGES_SET_ID,
  SMHI_WARNING_FILLS_SET_ID,
  createSmhiWarningsLayer,
  levelColor,
} from './index.js';

const NOW = Date.parse('2026-11-04T17:00:00Z');
const MINUTE = 60_000;
const CRISIS_LINK = 'https://www.krisinformation.se/nyheter/v';
const SETS = [
  SMHI_WARNING_FILLS_SET_ID,
  SMHI_WARNING_EDGES_SET_ID,
  SMHI_CRISIS_DOTS_SET_ID,
];

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

const crisis = (id, kind, extra = {}) => ({
  id,
  kind,
  point: [16, 60],
  headline: `Notice ${id}`,
  scope: 'country',
  updated: NOW,
  published: NOW,
  sender: 'Sender',
  ...extra,
});

/** A layer on a fake viewer, fed by `feed.areas` (or failing on `feed.error`). */
function harness(t, areas = [], options = {}) {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  // The sets the layer was given, so a test can make one of its writes fail.
  const made = new Map();
  for (const kind of ['shapes', 'lines', 'points']) {
    const make = draw[kind];
    draw[kind] = (spec) => {
      const set = make(spec);
      made.set(spec.id, set);
      return set;
    };
  }
  const feed = {
    areas,
    crisis: options.crisis ?? [],
    error: null,
    stale: false,
    fetchedAt: NOW,
  };
  const clock = { now: NOW };
  const state = { cards: [], clicks: [], cardHit: null, opened: [] };
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
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, SMHI_WARNINGS_OVERLAY_SOURCE_ID);
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
    terrain: options.terrain ?? null,
    now: () => clock.now,
  });
  layer.init(viewer);
  const setOf = (id) => draw.set(id);
  const ids = (id) => [...(setOf(id)?.items.keys() ?? [])];
  const drawn = () => SETS.flatMap(ids);
  const item = (setId, id) => setOf(setId)?.items.get(id);
  const click = (pickId = null) =>
    state.clicks.at(-1).callback({
      screenPosition: { x: 10, y: 20 },
      topHit: pickId ? { set: 'some-set', id: pickId, surface: false } : null,
    });
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
    made,
    setOf,
    ids,
    drawn,
    item,
    click,
    chip,
  };
}

const rgbOf = (css, alpha) => [...cssColor(css).slice(0, 3), alpha];

test('the warnings are three sets, shown only while the layer is on', async (t) => {
  const { layer, setOf, ids, state } = harness(t, [area('1:1')], {
    crisis: [crisis('v', 'vma')],
  });
  for (const id of SETS) assert.equal(setOf(id).show, false, id);
  layer.enable();
  for (const id of SETS) assert.equal(setOf(id).show, true, id);
  assert.equal(await layer.update(), true);
  assert.deepEqual(ids(SMHI_WARNING_FILLS_SET_ID), ['se-smhiwarn:1:1:fill0']);
  assert.deepEqual(ids(SMHI_WARNING_EDGES_SET_ID), ['se-smhiwarn:1:1:edge0']);
  assert.deepEqual(ids(SMHI_CRISIS_DOTS_SET_ID), ['se-krisinfo:v']);
  layer.disable();
  for (const id of SETS) assert.equal(setOf(id).show, false, id);
  assert.equal(state.clicks[0].off, true);
  layer.destroy();
  for (const id of SETS) assert.equal(setOf(id), undefined, `${id} disposed`);
});

test('the areas lie on every surface; the dots clamp to terrain only once they have ground heights', (t) => {
  const plain = harness(t);
  for (const id of SETS) assert.equal(plain.setOf(id).spec.clampTo, 'both');
  assert.equal(plain.setOf(SMHI_CRISIS_DOTS_SET_ID).spec.horizonCull, true);
  const terrain = { resolveEllipsoidalGround: async () => [] };
  const lifted = harness(t, [], { terrain });
  assert.equal(lifted.setOf(SMHI_WARNING_FILLS_SET_ID).spec.clampTo, 'both');
  assert.equal(lifted.setOf(SMHI_WARNING_EDGES_SET_ID).spec.clampTo, 'both');
  assert.equal(lifted.setOf(SMHI_CRISIS_DOTS_SET_ID).spec.clampTo, 'terrain');
});

test('an area is a clamped fill with its holes and a draped edge, coloured by level; one yet to start is paler and dashed', async (t) => {
  const hole = [
    [18.4, 67.2],
    [18.6, 67.2],
    [18.5, 67.4],
  ];
  const { layer, item, ids, chip } = harness(t, [
    area('now', {
      level: 'ORANGE',
      polygons: [{ outer: area('x').polygons[0].outer, holes: [hole] }],
    }),
    area('later', { level: 'RED', upcoming: true }),
    area('note', { level: 'MESSAGE' }),
  ]);
  layer.enable();
  await layer.update();
  const fill = item(SMHI_WARNING_FILLS_SET_ID, 'se-smhiwarn:now:fill0');
  assert.deepEqual(fill.geometry, {
    kind: 'polygon',
    rings: [
      [
        { lon: 18, lat: 67 },
        { lon: 19, lat: 67 },
        { lon: 19, lat: 68 },
      ],
      [
        { lon: 18.4, lat: 67.2 },
        { lon: 18.6, lat: 67.2 },
        { lon: 18.5, lat: 67.4 },
      ],
    ],
  });
  assert.deepEqual(fill.fill, rgbOf(levelColor('ORANGE'), 0.3));
  assert.equal(fill.height, 'clampGround');
  const edge = item(SMHI_WARNING_EDGES_SET_ID, 'se-smhiwarn:now:edge0');
  assert.equal(edge.mode, 'draped');
  assert.equal(edge.widthPx, 2.5);
  assert.deepEqual(edge.style, {
    kind: 'solid',
    color: rgbOf(levelColor('ORANGE'), 0.9),
  });
  // The edge closes the outer ring.
  assert.deepEqual(edge.positions, [
    fromDegrees(18, 67),
    fromDegrees(19, 67),
    fromDegrees(19, 68),
    fromDegrees(18, 67),
  ]);

  const later = item(SMHI_WARNING_FILLS_SET_ID, 'se-smhiwarn:later:fill0');
  assert.deepEqual(later.fill, rgbOf(levelColor('RED'), 0.12));
  assert.deepEqual(
    item(SMHI_WARNING_EDGES_SET_ID, 'se-smhiwarn:later:edge0').style,
    { kind: 'dash', color: rgbOf(levelColor('RED'), 0.85), length: 16 },
  );

  // Messages hide behind their chip, and draw a thinner edge.
  assert.equal(
    item(SMHI_WARNING_FILLS_SET_ID, 'se-smhiwarn:note:fill0'),
    undefined,
  );
  chip('messages');
  assert.equal(
    item(SMHI_WARNING_EDGES_SET_ID, 'se-smhiwarn:note:edge0').widthPx,
    1.5,
  );
  // Drawn in the feed's order, which the source sorts least severe first so
  // red lies over orange over yellow; a hidden one leaves its place.
  chip('upcoming');
  assert.deepEqual(ids(SMHI_WARNING_FILLS_SET_ID), [
    'se-smhiwarn:now:fill0',
    'se-smhiwarn:note:fill0',
  ]);
  layer.destroy();
});

test('a crisis message is a dot: a VMA large, news smaller, ringed white, spread around a shared place', async (t) => {
  const { layer, item, ids, chip } = harness(t, [], {
    crisis: [crisis('v', 'vma'), crisis('n', 'news')],
  });
  layer.enable();
  await layer.update();
  const vma = item(SMHI_CRISIS_DOTS_SET_ID, 'se-krisinfo:v');
  assert.equal(vma.pixelSize, 16);
  assert.equal(vma.color, '#ff1744');
  assert.equal(vma.outlineColor, '#ffffff');
  assert.equal(vma.outlineWidth, 3);
  assert.equal(vma.height, 'clampGround');
  assert.equal(vma.disableDepthTest, Number.POSITIVE_INFINITY);
  const news = item(SMHI_CRISIS_DOTS_SET_ID, 'se-krisinfo:n');
  assert.equal(news.pixelSize, 11);
  assert.equal(news.color, '#40c4ff');
  assert.equal(news.outlineWidth, 2);
  assert.notDeepEqual(
    [vma.pos.lon, vma.pos.lat],
    [news.pos.lon, news.pos.lat],
    'two notices of one place stand apart',
  );
  chip('crisis');
  assert.deepEqual(ids(SMHI_CRISIS_DOTS_SET_ID), []);
  layer.destroy();
});

test('a click on an area or a dot opens its card; its own card opens its page; the ground closes it', async (t) => {
  const { layer, state, click } = harness(t, [area('1:2')], {
    crisis: [crisis('v', 'vma', { link: CRISIS_LINK })],
  });
  layer.enable();
  await layer.update();
  // The edge is the area as much as the fill is.
  click('se-smhiwarn:1:2:edge0');
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['smhi-warning-card:1:2'],
  );
  assert.deepEqual(state.cards[0].position, fromDegrees(56 / 3, 202 / 3));
  click('se-smhiwarn:1:2:fill0');
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['smhi-warning-card:1:2'],
  );
  state.cardHit = {
    sourceId: SMHI_WARNINGS_OVERLAY_SOURCE_ID,
    entryId: state.cards[0].id,
  };
  click('se-krisinfo:v');
  assert.deepEqual(state.opened.splice(0), [SMHI_WARNINGS_PAGE]);
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['smhi-warning-card:1:2'],
    'the dot under its card is not picked',
  );
  state.cardHit = null;
  click('se-krisinfo:v');
  assert.deepEqual(
    state.cards.map((card) => card.id),
    ['krisinformation-card:v'],
  );
  state.cardHit = {
    sourceId: SMHI_WARNINGS_OVERLAY_SOURCE_ID,
    entryId: state.cards[0].id,
  };
  click();
  assert.deepEqual(state.opened.splice(0), [CRISIS_LINK]);
  state.cardHit = null;
  click();
  assert.deepEqual(state.cards, [], 'a click on the ground lets go');
  layer.destroy();
});

test("another layer's card or dot under a click leaves the selection", async (t) => {
  const { layer, state, click } = harness(t, [area('1:1')]);
  layer.enable();
  await layer.update();
  click('se-smhiwarn:1:1:fill0');
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  click();
  assert.equal(state.cards.length, 1);
  state.cardHit = null;
  picking.registerPickOwner('other-layer', (id) => id.startsWith('other:'));
  t.after(() => picking.unregisterPickOwner('other-layer'));
  click('other:1');
  assert.equal(state.cards.length, 1);
  assert.deepEqual(state.opened, []);
  // The warnings own no picks: large areas would make others' inert.
  assert.equal(picking.findPickOwner('se-smhiwarn:1:1:fill0'), null);
  layer.destroy();
});

test('a selected area hidden by a toggle loses its card', async (t) => {
  const { layer, state, click, chip } = harness(t, [
    area('soon', { upcoming: true }),
  ]);
  layer.enable();
  await layer.update();
  click('se-smhiwarn:soon:fill0');
  assert.equal(state.cards.length, 1);
  chip('upcoming');
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('ground heights move only the crisis dots drawn, and the card with them', async (t) => {
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const terrain = {
    resolveEllipsoidalGround: async (points) => {
      await answered;
      return points.map(() => ({ ellipsoid: 42, source: 'reearth' }));
    },
  };
  const { layer, state, item, click, made } = harness(t, [area('1:1')], {
    crisis: [crisis('v', 'vma', { point: [14, 58] })],
    terrain,
  });
  layer.enable();
  await layer.update();
  click('se-krisinfo:v');
  const fills = made.get(SMHI_WARNING_FILLS_SET_ID);
  const upsert = t.mock.method(fills, 'upsert');
  answer();
  for (
    let i = 0;
    i < 50 && item(SMHI_CRISIS_DOTS_SET_ID, 'se-krisinfo:v').pos.height !== 42;
    i += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const dot = item(SMHI_CRISIS_DOTS_SET_ID, 'se-krisinfo:v');
  assert.equal(dot.pos.height, 42);
  assert.equal(upsert.mock.callCount(), 0, 'the areas stay as they are');
  assert.deepEqual(
    state.cards[0].position,
    fromDegrees(dot.pos.lon, dot.pos.lat, 42),
  );
  layer.destroy();
});

test('a drawing that failed is reported as one, and drawn again next time', async (t) => {
  const { layer, warn, drawn, made } = harness(t, [area('1:1')]);
  layer.enable();
  t.mock.method(
    made.get(SMHI_WARNING_FILLS_SET_ID),
    'set',
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
