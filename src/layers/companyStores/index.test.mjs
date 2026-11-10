import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPANY_STORES_OVERLAY_SOURCE_ID,
  createCompanyStoresLayer,
} from './index.js';

/** A store row of a snapshot, a kilometre north of the one before. */
const store = (id, extra = {}) => ({
  id: `n${id}`,
  company: 'ica',
  brand: 'ICA Nära',
  name: `ICA Nära ${id}`,
  point: [18.06, 59.33 + id * 0.01],
  address: 'Storgatan 1',
  hours: null,
  website: `https://www.ica.se/butiker/${id}/`,
  ...extra,
});
const snapshot = (stores) => ({
  stores,
  companies: [],
  osmBase: '2026-11-01T00:00:00Z',
  populationYear: 2025,
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
function harness(stores, options = {}) {
  const viewer = fakeViewer();
  const state = { cards: [], cardHit: null, click: null, opened: [] };
  const layer = createCompanyStoresLayer({
    source: { getSnapshot: async () => snapshot(stores) },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, COMPANY_STORES_OVERLAY_SOURCE_ID);
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
const ownCard = (card) => ({
  sourceId: COMPANY_STORES_OVERLAY_SOURCE_ID,
  entryId: card.id,
});

test('a click on a store shows its card, and a click on the card its page', async () => {
  const { layer, viewer, state } = harness([store(1), store(2)]);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(viewer.sources[0].entities.values.length, 2);

  viewer.picked = { id: 'se-store:n1' };
  state.click(CLICK);
  assert.equal(state.cards.length, 1);
  const [card] = state.cards;
  assert.equal(card.id, 'company-stores-card:n1');
  assert.equal(card.interactive, true);
  assert.equal(typeof card.activate, 'function');

  // On the card: the page opens, and the dot under the card is not picked.
  viewer.picked = { id: 'se-store:n2' };
  state.cardHit = ownCard(card);
  state.click(CLICK);
  assert.deepEqual(state.opened, [store(1).website]);
  assert.equal(state.cards[0].id, card.id, 'the selection stays');

  state.cardHit = null;
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
  layer.destroy();
});

test("a click on another layer's card is not a click on the ground", async () => {
  const { layer, viewer, state } = harness([store(1), store(2)]);
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-store:n1' };
  state.click(CLICK);

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  viewer.picked = undefined;
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, 'company-stores-card:n1', 'still selected');
  viewer.picked = { id: 'se-store:n2' };
  state.click(CLICK);
  assert.equal(
    state.cards[0]?.id,
    'company-stores-card:n1',
    'the store behind the card is not selected',
  );
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('the card of a store without a web page is still hit, and opens nothing', async () => {
  const { layer, viewer, state } = harness([
    store(1, { website: undefined }),
    store(2),
  ]);
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-store:n1' };
  state.click(CLICK);
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);
  assert.equal('accessibilityLabel' in card, false);

  viewer.picked = { id: 'se-store:n2' };
  state.cardHit = ownCard(card);
  state.click(CLICK);
  assert.equal(state.cards[0]?.id, card.id, 'the selection stays');
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('without a way to open pages the card is still hit, and opens nothing', async () => {
  const { layer, viewer, state } = harness([store(1)], { openExternal: null });
  layer.enable();
  await layer.update();
  viewer.picked = { id: 'se-store:n1' };
  state.click(CLICK);
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);

  viewer.picked = undefined;
  state.cardHit = ownCard(card);
  state.click(CLICK);
  assert.equal(state.cards.length, 1, 'the selection stays');
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('the layer shows tidy stores: one per store, with the chain’s own links', async () => {
  const { layer, viewer, state } = harness([
    store(1, { website: 'https://www.icabostrom.se/' }),
    // The same store once more, 11 m north, and an agent in a kiosk.
    store(3, { point: [18.06, 59.3401], website: undefined }),
    store(4, { company: 'systembolaget', name: 'Systembolaget ombud' }),
    store(5, { company: 'city-gross', brand: 'City Gross', website: undefined }),
  ]);
  layer.enable();
  await layer.update();
  assert.deepEqual(
    viewer.sources[0].entities.values.map((entity) => entity.id),
    ['se-store:n1', 'se-store:n5'],
  );
  assert.equal(layer.getStats().count, 2);
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((item) => [item.label, item.count]),
    [
      ['ICA Nära', 1],
      ['City Gross', 1],
    ],
  );

  viewer.picked = { id: 'se-store:n1' };
  state.click(CLICK);
  assert.equal(state.cards[0].activate, undefined, 'not the chain’s page');
  viewer.picked = { id: 'se-store:n3' };
  state.click(CLICK);
  assert.equal(state.cards.length, 0, 'the twin is gone');
  layer.destroy();
});
