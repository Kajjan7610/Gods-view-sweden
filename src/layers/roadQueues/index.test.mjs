// The queues layer's clean-up: what it puts on the map goes with it. The
// only text it writes there is the card of a clicked stretch or measuring
// point; the "T5 · 3 min" labels over the airports' security checkpoints
// follow its switch, and are drawn and cleared by src/ui/airportQueues.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  ROAD_QUEUES_LINES_SET_ID,
  ROAD_QUEUES_OVERLAY_SOURCE_ID,
  ROAD_QUEUES_POINTS_SET_ID,
  createRoadQueuesLayer,
} from './index.js';

const NOW = Date.parse('2026-11-21T16:30:00+01:00');

const route = {
  id: '101',
  name: 'Essingeleden norrut',
  status: 'congested',
  travelTimeS: 80,
  normalS: 50,
  delayS: 30,
  speedKmh: 31.5,
  lengthM: 700,
  measuredAt: NOW - 60_000,
  lines: [
    [
      [18.0, 59.32],
      [18.01, 59.325],
      [18.02, 59.33],
    ],
  ],
};
const point = {
  id: '2001',
  point: [18.05, 59.34],
  side: 'northbound',
  lanes: 2,
  flow: 1800,
  normalFlow: 2200,
  speed: 25,
  normalSpeed: 70,
  speedStdDev: 8,
  status: 'queue',
  measuredAt: NOW - 60_000,
  county: 1,
};

function harness() {
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const host = { shown: new Map(), visible: new Map(), written: new Set() };
  const state = { click: null, picked: null };
  let answer = () => Promise.resolve({ routes: [route], points: [point] });
  const layer = createRoadQueuesLayer({
    source: { getSnapshot: () => answer() },
    overlayHost: {
      setEntries(sourceId, entries) {
        host.written.add(sourceId);
        host.shown.set(sourceId, entries);
      },
      clearSource: (sourceId) => host.shown.delete(sourceId),
      setVisible: (sourceId, on) => host.visible.set(sourceId, on),
      hitTest: () => null,
    },
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 1, y: 1 },
            topHit: state.picked
              ? { set: ROAD_QUEUES_LINES_SET_ID, id: state.picked }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
    now: () => NOW,
  });
  layer.init(viewer);
  return {
    layer,
    draw,
    host,
    state,
    answerWith: (next) => (answer = next),
  };
}

test('turning the layer off takes its card off the map, lines and dots too', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { layer, draw, host, state } = harness();
  layer.enable();
  await layer.update();
  state.picked = 'se-queue:r:101:0';
  state.click();
  const [card] = host.shown.get(ROAD_QUEUES_OVERLAY_SOURCE_ID);
  assert.match(card.details[0], /1 min 20 s/);
  assert.equal(host.visible.get(ROAD_QUEUES_OVERLAY_SOURCE_ID), true);
  layer.disable();
  // Every source the layer wrote to is emptied and hidden.
  for (const sourceId of host.written) {
    assert.equal(host.shown.get(sourceId), undefined, sourceId);
    assert.equal(host.visible.get(sourceId), false, sourceId);
  }
  assert.deepEqual([...host.written], [ROAD_QUEUES_OVERLAY_SOURCE_ID]);
  assert.equal(draw.set(ROAD_QUEUES_LINES_SET_ID).show, false);
  assert.equal(draw.set(ROAD_QUEUES_POINTS_SET_ID).show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
});

test('an answer that arrives after the layer is off puts nothing back', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { layer, host, answerWith } = harness();
  let release;
  answerWith(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ routes: [route], points: [point] });
      }),
  );
  layer.enable();
  const pending = layer.update();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(host.shown.get(ROAD_QUEUES_OVERLAY_SOURCE_ID), undefined);
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy();
});

test('the row says the airports’ security queues come with the layer', (t) => {
  t.mock.method(console, 'log', () => {});
  const { layer } = harness();
  assert.match(layer.getRowControls().info, /security queues .*(Swedavia)/);
  layer.destroy();
});
