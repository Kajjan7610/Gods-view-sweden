// The Weather card lists the worst readings in view, so it must follow the
// camera between the 20-minute data refreshes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';

function fakeViewer() {
  const listeners = new Set();
  return {
    dataSources: { add() {}, remove() {} },
    camera: {
      moveEnd: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    settle: () => listeners.forEach((listener) => listener()),
    listeners,
  };
}

test('a settled camera re-reads the card while the layer is on', () => {
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = fakeViewer();
  let reads = 0;
  layer.init(viewer);
  layer.setRowControlsListener(() => (reads += 1));

  viewer.settle();
  assert.equal(reads, 0, 'off: the camera is not followed');

  layer.enable();
  layer.enable();
  assert.equal(viewer.listeners.size, 1, 'one subscription, however often');
  reads = 0;
  viewer.settle();
  assert.equal(reads, 1);

  layer.disable();
  assert.equal(viewer.listeners.size, 0);
  layer.enable();
  layer.destroy(viewer);
  assert.equal(viewer.listeners.size, 0, 'destroy lets go of the camera');
});
