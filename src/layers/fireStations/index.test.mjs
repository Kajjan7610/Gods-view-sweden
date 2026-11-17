import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { FIRE_STATIONS_OVERLAY_SOURCE_ID } from './cards.js';
import { createFireStationsLayer, readinessColor } from './index.js';

const station = (id, readiness, extra = {}) => ({
  id,
  point: [13.19, 59.39],
  name: null,
  readiness,
  near: null,
  ...extra,
});

const snapshot = (stations) => ({ stations, stale: false, fetchedAt: 1 });

function harness({ snapshots = [], terrain = null, cardHit = null } = {}) {
  const cards = [];
  const handlers = [];
  let pickResult = null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const queue = [...snapshots];
  const layer = createFireStationsLayer({
    source: { getSnapshot: () => Promise.resolve(queue.shift()) },
    overlayHost: {
      setEntries: (source, entries) => cards.push({ source, entries }),
      setVisible() {},
      clearSource() {},
      hitTest: () => cardHit,
    },
    // The globe's clicks: one listener per click handler installed.
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 1, y: 1 },
              topHit: pickResult
                ? { set: 'fire-stations', id: pickResult, surface: false }
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
    terrain,
  });
  layer.init(viewer);
  return {
    layer,
    dots: () => draw.find('fire-stations'),
    items: () => [...(draw.find('fire-stations')?.items.values() ?? [])],
    handlers,
    click(pickId) {
      pickResult = pickId;
      handlers.at(-1).click();
    },
    lastCard: () => cards.at(-1),
    setCardHit(hit) {
      cardHit = hit;
    },
  };
}

test('the stations are one set of dots, shown only while the layer is on', async () => {
  const h = harness({
    snapshots: [snapshot([station('a', 'full-time'), station('b', null)])],
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

test('a dot is coloured and sized by readiness, full-time drawn last', async () => {
  const h = harness({
    snapshots: [
      snapshot([station('a', 'full-time'), station('b', 'rescue-post')]),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  const [first, last] = h.items();
  assert.equal(first.id, 'se-fire-station:b');
  assert.equal(last.id, 'se-fire-station:a');
  assert.equal(last.pixelSize, 11);
  assert.equal(first.pixelSize, 7);
  assert.equal(last.color, readinessColor('full-time'));
  assert.equal(last.height, 'clampGround');
  assert.deepEqual(last.pos, { lon: 13.19, lat: 59.39, height: 0 });
  assert.equal(last.disableDepthTest, Number.POSITIVE_INFINITY);
});

test('without ground heights the dots clamp to every surface; with them to terrain only', () => {
  assert.equal(harness().dots().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness({ terrain }).dots().spec.clampTo, 'terrain');
});

test('a click on a dot opens its card; the ground closes it', async () => {
  const h = harness({ snapshots: [snapshot([station('a', 'full-time')])] });
  h.layer.enable();
  await h.layer.update();
  h.click('se-fire-station:a');
  const opened = h.lastCard();
  assert.equal(opened.source, FIRE_STATIONS_OVERLAY_SOURCE_ID);
  assert.equal(opened.entries.length, 1);
  assert.ok(opened.entries[0].position, 'the card sits on the station');
  h.click(null);
  assert.equal(h.lastCard().entries.length, 0);
});

test("a click on another layer's card or dot leaves the open card alone", async () => {
  const h = harness({ snapshots: [snapshot([station('a', 'full-time')])] });
  h.layer.enable();
  await h.layer.update();
  h.click('se-fire-station:a');
  const writes = () => h.lastCard();
  const before = writes();
  h.setCardHit({ sourceId: 'hospitals', entryId: 'hospitals-card:x' });
  h.click(null);
  assert.equal(writes(), before, 'a card is not the ground');
  h.setCardHit(null);
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    h.click('se-hospital:1');
    assert.equal(writes(), before, "another layer's dot is not the ground");
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
});
