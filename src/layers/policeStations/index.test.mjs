import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { clearGroundHeightStore } from '../groundHeights.js';
import {
  POLICE_STATIONS_OVERLAY_SOURCE_ID,
  createPoliceStationsLayer,
  deskColor,
} from './index.js';

const station = (id, extra = {}) => ({
  id,
  point: [18.04, 59.33],
  name: `Station ${id}`,
  address: 'Storgatan 1',
  url: `https://polisen.se/om-polisen/kontakt/polisstationer/x/${id}/`,
  services: ['report'],
  ...extra,
});
const snapshot = (stations) => ({
  stale: false,
  fetchedAt: Date.parse('2026-11-09T18:00:00Z'),
  stations,
});

/**
 * The layer on a fake draw port, with a card host and globe clicks a test
 * can drive: `click(pickId)` clicks with that item on top (null: the ground).
 */
function harness(source, options = {}) {
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const state = { cards: [], cardHit: null, opened: [], picked: null };
  const handlers = [];
  const layer = createPoliceStationsLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, POLICE_STATIONS_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 10, y: 20 },
              topHit: state.picked
                ? { set: 'police-stations', id: state.picked, surface: false }
                : null,
            }),
          destroyed: false,
        };
        handlers.push(handler);
        return () => {
          handler.destroyed = true;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    openExternal: (url) => state.opened.push(url),
    ...options,
  });
  layer.init(viewer);
  return {
    layer,
    state,
    handlers,
    dots: () => draw.find('police-stations'),
    items: () => [...(draw.find('police-stations')?.items.values() ?? [])],
    click(pickId) {
      state.picked = pickId;
      handlers.at(-1).click();
    },
  };
}

test('the stations are one set of dots, shown only while the layer is on', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  assert.equal(h.dots().show, false);
  h.layer.enable();
  assert.equal(h.dots().show, true);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.items().length, 2);
  assert.equal(h.layer.getStats().count, 2);
  h.layer.disable();
  assert.equal(h.dots().show, false);
  assert.equal(h.handlers[0].destroyed, true);
  h.layer.destroy();
  assert.equal(h.dots(), undefined, 'the set is disposed');
});

test('a dot is coloured and sized by its desk, passport desks drawn last', async () => {
  const passport = station('1', { services: ['passport-apply', 'report'] });
  const bare = station('2', { services: [] });
  const h = harness({ getSnapshot: async () => snapshot([passport, bare]) });
  h.layer.enable();
  await h.layer.update();
  const [first, last] = h.items();
  assert.equal(first.id, 'se-police-station:2');
  assert.equal(last.id, 'se-police-station:1');
  assert.equal(last.pixelSize, 10);
  assert.equal(first.pixelSize, 7);
  assert.equal(last.color, deskColor(passport));
  assert.equal(first.color, deskColor(bare));
  assert.equal(last.outlineColor, '#0b1a2b');
  assert.equal(last.outlineWidth, 1.5);
  assert.equal(last.height, 'clampGround');
  assert.deepEqual(last.pos, { lon: 18.04, lat: 59.33, height: 0 });
  assert.equal(last.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(last.scaleByDistance, {
    near: 2e4,
    nearValue: 1.2,
    far: 2e6,
    farValue: 0.7,
  });
  h.layer.destroy();
});

test('without ground heights the dots clamp to every surface; with them to terrain only', () => {
  const source = { getSnapshot: async () => snapshot([]) };
  assert.equal(harness(source).dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness(source, { terrain }).dots().spec.clampTo, 'terrain');
});

test('a click on a station shows its card, and a click on the card its page', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  h.layer.enable();
  await h.layer.update();

  h.click('se-police-station:1');
  assert.equal(h.state.cards.length, 1);
  const [card] = h.state.cards;
  assert.equal(card.id, 'police-stations-card:1');
  assert.equal(typeof card.activate, 'function');
  assert.ok(card.position, 'the card sits on the station');

  // On the card: the page opens, and the dot under the card is not picked.
  h.state.cardHit = {
    sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID,
    entryId: card.id,
  };
  h.click('se-police-station:2');
  assert.deepEqual(h.state.opened, [station('1').url]);
  assert.equal(h.state.cards[0].id, card.id, 'the selection stays');

  h.state.cardHit = null;
  h.click(null);
  assert.equal(h.state.cards.length, 0, 'a click on the ground lets go');
  h.layer.destroy();
});

test("a click on another layer's card or dot is not a click on the ground", async () => {
  const h = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  h.layer.enable();
  await h.layer.update();
  h.click('se-police-station:1');

  h.state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  h.click(null);
  assert.equal(
    h.state.cards[0]?.id,
    'police-stations-card:1',
    'still selected',
  );
  h.click('se-police-station:2');
  assert.equal(
    h.state.cards[0]?.id,
    'police-stations-card:1',
    'the station behind the card is not selected',
  );
  assert.deepEqual(h.state.opened, []);

  h.state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(
      h.state.cards[0]?.id,
      'police-stations-card:1',
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  h.layer.destroy();
});

test('without a way to open pages the card is still hit, and opens nothing', async () => {
  const h = harness(
    { getSnapshot: async () => snapshot([station('1')]) },
    { openExternal: null },
  );
  h.layer.enable();
  await h.layer.update();
  h.click('se-police-station:1');
  const [card] = h.state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);

  h.state.cardHit = {
    sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID,
    entryId: card.id,
  };
  h.click(null);
  assert.equal(h.state.cards.length, 1, 'the selection stays');
  h.layer.destroy();
});

test('a station that changes name, address or page is drawn again', async () => {
  let rows = [station('1')];
  const h = harness({ getSnapshot: async () => snapshot(rows) });
  h.layer.enable();
  await h.layer.update();
  h.click('se-police-station:1');
  assert.ok(h.state.cards[0].details.includes('Storgatan 1'));

  rows = [station('1', { address: 'Nygatan 2' })];
  await h.layer.update();
  assert.ok(h.state.cards[0].details.includes('Nygatan 2'));

  rows = [station('1', { address: 'Nygatan 2', name: 'Nya stationen' })];
  await h.layer.update();
  assert.match(h.state.cards[0].title, /NYA STATIONEN/);

  rows = [
    station('1', { address: 'Nygatan 2', name: 'Nya stationen', url: null }),
  ];
  await h.layer.update();
  assert.equal(h.state.cards[0].activate, undefined, 'no page left to open');
  h.layer.destroy();
});

/** Terrain that answers 40 m everywhere, and counts what it was asked. */
function fakeTerrain() {
  const asked = [];
  return {
    asked,
    resolveEllipsoidalGround: async (points) => {
      asked.push(points.length);
      return points.map(() => ({ ellipsoid: 40, source: 'reearth' }));
    },
  };
}

const settled = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test('ground heights lift the dots where they are; a browser that kept them asks nothing', async (t) => {
  clearGroundHeightStore();
  t.after(clearGroundHeightStore);
  const rows = [
    station('1'),
    station('2', { point: [11.97, 57.71] }),
    station('3', { point: [13.0, 55.6] }),
  ];
  const source = { getSnapshot: async () => snapshot(rows) };

  const terrain = fakeTerrain();
  const first = harness(source, { terrain });
  first.layer.enable();
  await first.layer.update();
  const ids = first.items().map((item) => item.id);
  assert.equal(first.dots().writes, 1, 'drawn once, before any answer');
  assert.ok(first.items().every((item) => item.pos.height === 0));

  await settled();
  assert.deepEqual(terrain.asked, [3], 'one request for the three places');
  assert.deepEqual(
    first.items().map((item) => item.id),
    ids,
    'the same dots are still there',
  );
  assert.ok(first.items().every((item) => item.pos.height === 40));
  assert.equal(first.dots().writes, 2, 'moved, not drawn again');
  first.layer.destroy();

  // The next visit: the heights are in the first drawing, nothing is asked.
  const again = fakeTerrain();
  const second = harness(source, { terrain: again });
  second.layer.enable();
  await second.layer.update();
  await settled();
  assert.equal(second.dots().writes, 1, 'one drawing, no lift after it');
  assert.ok(second.items().every((item) => item.pos.height === 40));
  assert.deepEqual(again.asked, []);
  second.layer.destroy();
});
