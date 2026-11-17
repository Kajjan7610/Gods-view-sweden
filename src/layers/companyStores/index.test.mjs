import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  COMPANY_STORES_OVERLAY_SOURCE_ID,
  createCompanyStoresLayer,
  storeColor,
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

/** The layer with a card host and globe clicks a test can drive. */
function harness(stores, options = {}) {
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const state = {
    cards: [],
    cardHit: null,
    click: null,
    picked: null,
    opened: [],
  };
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
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 10, y: 20 },
            topHit: state.picked
              ? { set: 'company-stores', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
    openExternal: (url) => state.opened.push(url),
    ...options,
  });
  layer.init(viewer);
  const set = () => draw.find('company-stores');
  const dots = () => [...(set()?.items.values() ?? [])];
  return { layer, state, set, dots };
}

const ownCard = (card) => ({
  sourceId: COMPANY_STORES_OVERLAY_SOURCE_ID,
  entryId: card.id,
});

test('the stores are one set of dots, shown only while the layer is on', async () => {
  const { layer, state, set, dots } = harness([store(1), store(2)]);
  assert.equal(set().kind, 'points');
  assert.equal(set().show, false);
  // Terrain only: thousands of dots on 3D tiles freeze the app.
  assert.equal(set().spec.clampTo, 'terrain');
  assert.equal(set().spec.horizonCull, true);
  layer.enable();
  assert.equal(set().show, true);
  await layer.update();
  assert.equal(dots().length, 2);
  layer.disable();
  assert.equal(set().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
  assert.equal(set(), undefined, 'the set is disposed');
});

test('a dot is coloured by its store, at its bundled height', async () => {
  const { layer, dots } = harness([store(1, { height: 31 }), store(2)]);
  layer.enable();
  await layer.update();
  const [first, second] = dots();
  assert.equal(first.id, 'se-store:n1');
  assert.equal(first.color, storeColor(store(1)));
  assert.equal(first.pixelSize, 8);
  assert.equal(first.outlineColor, '#101418');
  assert.equal(first.outlineWidth, 1.5);
  assert.equal(first.height, 'clampGround');
  const [lon, lat] = store(1).point;
  assert.deepEqual(first.pos, { lon, lat, height: 31 });
  assert.equal(second.pos.height, 0, 'no bundled height is 0');
  assert.equal(first.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(first.scaleByDistance, {
    near: 2e4,
    nearValue: 1.3,
    far: 2e6,
    farValue: 0.6,
  });
  layer.destroy();
});

test('a company chip hides its stores and their card', async () => {
  const { layer, state, dots } = harness([
    store(1),
    store(2, { company: 'city-gross', brand: 'City Gross' }),
  ]);
  layer.enable();
  await layer.update();
  state.picked = 'se-store:n1';
  state.click();
  assert.equal(state.cards.length, 1);
  const ica = layer.getRowControls().chips.find((c) => c.id === 'company-ica');
  ica.onClick();
  assert.deepEqual(
    dots().map((item) => item.id),
    ['se-store:n2'],
  );
  assert.equal(state.cards.length, 0, 'the hidden store’s card goes');
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('a click on a store shows its card, and a click on the card its page', async () => {
  const { layer, state, dots } = harness([store(1), store(2)]);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(dots().length, 2);

  state.picked = 'se-store:n1';
  state.click();
  assert.equal(state.cards.length, 1);
  const [card] = state.cards;
  assert.equal(card.id, 'company-stores-card:n1');
  assert.equal(card.interactive, true);
  assert.equal(typeof card.activate, 'function');
  assert.ok(card.position, 'the card sits on the store');

  // On the card: the page opens, and the dot under the card is not picked.
  state.picked = 'se-store:n2';
  state.cardHit = ownCard(card);
  state.click();
  assert.deepEqual(state.opened, [store(1).website]);
  assert.equal(state.cards[0].id, card.id, 'the selection stays');

  state.cardHit = null;
  state.picked = null;
  state.click();
  assert.equal(state.cards.length, 0, 'a click on the ground lets go');
  layer.destroy();
});

test("a click on another layer's card is not a click on the ground", async () => {
  const { layer, state } = harness([store(1), store(2)]);
  layer.enable();
  await layer.update();
  state.picked = 'se-store:n1';
  state.click();

  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  state.picked = null;
  state.click();
  assert.equal(state.cards[0]?.id, 'company-stores-card:n1', 'still selected');
  state.picked = 'se-store:n2';
  state.click();
  assert.equal(
    state.cards[0]?.id,
    'company-stores-card:n1',
    'the store behind the card is not selected',
  );
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test("a click on another layer's dot leaves the open card alone", async () => {
  const { layer, state } = harness([store(1)]);
  layer.enable();
  await layer.update();
  state.picked = 'se-store:n1';
  state.click();
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    state.picked = 'se-hospital:1';
    state.click();
    assert.equal(state.cards[0]?.id, 'company-stores-card:n1');
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  layer.destroy();
});

test('the card of a store without a web page is still hit, and opens nothing', async () => {
  const { layer, state } = harness([
    store(1, { website: undefined }),
    store(2),
  ]);
  layer.enable();
  await layer.update();
  state.picked = 'se-store:n1';
  state.click();
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);
  assert.equal('accessibilityLabel' in card, false);

  state.picked = 'se-store:n2';
  state.cardHit = ownCard(card);
  state.click();
  assert.equal(state.cards[0]?.id, card.id, 'the selection stays');
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('without a way to open pages the card is still hit, and opens nothing', async () => {
  const { layer, state } = harness([store(1)], { openExternal: null });
  layer.enable();
  await layer.update();
  state.picked = 'se-store:n1';
  state.click();
  const [card] = state.cards;
  assert.equal(card.interactive, true);
  assert.equal(card.activate, undefined);

  state.picked = null;
  state.cardHit = ownCard(card);
  state.click();
  assert.equal(state.cards.length, 1, 'the selection stays');
  assert.deepEqual(state.opened, []);
  layer.destroy();
});

test('the layer shows tidy stores: one per store, with the chain’s own links', async () => {
  const { layer, state, dots } = harness([
    store(1, { website: 'https://www.icabostrom.se/' }),
    // The same store once more, 11 m north, and an agent in a kiosk.
    store(3, { point: [18.06, 59.3401], website: undefined }),
    store(4, { company: 'systembolaget', name: 'Systembolaget ombud' }),
    store(5, {
      company: 'city-gross',
      brand: 'City Gross',
      website: undefined,
    }),
  ]);
  layer.enable();
  await layer.update();
  assert.deepEqual(
    dots().map((item) => item.id),
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

  state.picked = 'se-store:n1';
  state.click();
  assert.equal(state.cards[0].activate, undefined, 'not the chain’s page');
  state.picked = 'se-store:n3';
  state.click();
  assert.equal(state.cards.length, 0, 'the twin is gone');
  layer.destroy();
});
