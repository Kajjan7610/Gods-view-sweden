import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLICE_STATIONS_OVERLAY_SOURCE_ID,
  createPoliceStationsLayer,
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

/** A viewer, as far as the layer looks at one. */
function fakeViewer() {
  const sources = [];
  const viewer = {
    sources,
    picked: undefined,
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
    scene: {
      pick: () => viewer.picked,
      requestRender() {},
    },
  };
  return viewer;
}

/** The layer with a card host and a click handler a test can drive. */
function harness(source, options = {}) {
  const viewer = fakeViewer();
  const state = { cards: [], cardHit: null, click: null, opened: [] };
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
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    openExternal: (url) => state.opened.push(url),
    ...options,
  });
  layer.init(viewer);
  return { layer, viewer, state };
}

const CLICK = { position: { x: 10, y: 20 } };

test('a click on a station shows its card, and a click on the card its page', async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(viewer.sources[0].entities.values.length, 2);

  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  assert.equal(state.cards.length, 1);
  const [card] = state.cards;
  assert.equal(card.id, 'police-stations-card:1');
  assert.equal(typeof card.activate, 'function');

  // On the card: the page opens, and the dot under the card is not picked.
  viewer.picked = { id: 'se-police-station:2' };
  state.cardHit = { sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID, entryId: card.id };
  state.click(CLICK);
  assert.deepEqual(state.opened, [station('1').url]);
  assert.equal(state.cards[0].id, card.id, 'the selection stays');

  state.cardHit = null;
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
  layer.destroy();
});

test("a click on another layer's card is not a click on the ground", async () => {
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot([station('1'), station('2')]),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'police-stations-card:1', 'still selected');
  viewer.picked = { id: 'se-police-station:2' };
  state.click(CLICK);
  assert.equal(
    state.cards[0]?.id,
    'police-stations-card:1',
    'the station behind the card is not selected',
  );
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('without a way to open pages the card is still hit, and opens nothing', async () => {
  const { layer, viewer, state } = harness(
    { getSnapshot: async () => snapshot([station('1')]) },
    { openExternal: null },
  );
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);

  viewer.picked = undefined;
  state.cardHit = { sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID, entryId: card.id };
  state.click(CLICK);
  assert.equal(state.cards.length, 1, 'the selection stays');
  layer.destroy();
});

test('a station that changes name, address or page is drawn again', async () => {
  let rows = [station('1')];
  const { layer, viewer, state } = harness({
    getSnapshot: async () => snapshot(rows),
  });
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-police-station:1' };
  state.click(CLICK);
  assert.ok(state.cards[0].details.includes('Storgatan 1'));

  rows = [station('1', { address: 'Nygatan 2' })];
  await layer.update();
  assert.ok(state.cards[0].details.includes('Nygatan 2'));

  rows = [station('1', { address: 'Nygatan 2', name: 'Nya stationen' })];
  await layer.update();
  assert.match(state.cards[0].title, /NYA STATIONEN/);

  rows = [station('1', { address: 'Nygatan 2', name: 'Nya stationen', url: null })];
  await layer.update();
  assert.equal(state.cards[0].activate, undefined, 'no page left to open');
  layer.destroy();
});
