// The security queue labels: read only while the terminals are in view,
// never shown once they are old, and read again when the page is looked at;
// a marker or a label clicked opens the board.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { queueReachKm } from './airportBoardModel.js';
import { createAirportQueues } from './airportQueues.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const MINUTE = 60_000;
const BROMMA = { lat: 59.3544, lon: 17.9417 };
// Tureberg in Sollentuna: about nine kilometres from Bromma's terminal.
const SOLLENTUNA = { lat: 59.4327, lon: 17.8993 };
const settle = async () => {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const state = {
    now: NOW,
    center: SOLLENTUNA,
    height: 1325,
    hidden: false,
    down: false,
    stale: false,
    updatedAt: null,
    urls: [],
    labels: [],
    listeners: new Map(),
    // What a click lands on: a label's entry id, or a drawn item's hit.
    labelHit: null,
    picked: null,
    click: null,
    opened: [],
    cockpit: false,
  };
  const host = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({ pose: { height: state.height } });
  const { draw } = bindFakeDraw(host, {
    camera: camera.port,
    query: {
      pickEllipsoid: () => fromDegrees(state.center.lon, state.center.lat, 0),
    },
  });
  const queues = createAirportQueues({
    viewer: host,
    overlayHost: {
      setEntries: (sourceId, entries) => {
        state.labels = entries;
      },
      setVisible() {},
      clearSource() {},
      hitTest: () => (state.labelHit ? { entryId: state.labelHit } : null),
    },
    openBoard: (iata) => state.opened.push(iata),
    fetchImpl: async (url) => {
      state.urls.push(String(url));
      if (state.down) return { ok: false, status: 502 };
      return {
        ok: true,
        json: async () => ({
          security: [
            {
              id: '1',
              name: 'Security Bromma',
              terminal: null,
              minutes: 4,
              fastTrack: false,
              overflow: false,
              lat: 59.35553,
              lon: 17.94556,
            },
          ],
          stale: state.stale,
          updatedAt: state.updatedAt ?? state.now,
        }),
      };
    },
    documentRef: {
      body: { classList: { contains: () => state.cockpit } },
      get visibilityState() {
        return state.hidden ? 'hidden' : 'visible';
      },
      addEventListener: (type, listener) => state.listeners.set(type, listener),
      removeEventListener: (type) => state.listeners.delete(type),
    },
    now: () => state.now,
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({ screenPosition: { x: 1, y: 1 }, topHit: state.picked });
        return () => (state.click = null);
      },
    }),
  });
  t.after(() => queues.destroy());
  /** The camera comes to rest over `center` at `height` metres. */
  const view = async (center, height) => {
    state.center = center;
    state.height = height;
    camera.setPose({ height });
    camera.emit('moveEnd');
    t.mock.timers.tick(600);
    await settle();
  };
  /** Three minutes pass and the refresh, if any, runs. */
  const refresh = async () => {
    state.now += 3 * MINUTE;
    t.mock.timers.tick(3 * MINUTE);
    await settle();
  };
  const markers = () => draw.set('airport-queues');
  return { state, view, refresh, markers, queues, camera };
}

test('the reach follows the height of the view, within bounds', () => {
  assert.equal(queueReachKm(1325), 2);
  assert.equal(queueReachKm(10_000), 8);
  assert.equal(queueReachKm(40_000), 20);
  assert.equal(queueReachKm(undefined), 0);
});

test('the queues are read only while the terminals are in view', async (t) => {
  const { state, view } = harness(t);
  // A street-level view in Sollentuna: Bromma is near, and far out of view.
  await view(SOLLENTUNA, 1325);
  assert.deepEqual(state.urls, []);
  // The same place from fourteen kilometres up: Bromma is in the picture.
  await view(SOLLENTUNA, 14_000);
  assert.deepEqual(state.urls, ['/api/airport-board?iata=BMA&only=security']);
  assert.equal(state.labels.length, 1);
  // Down again: the labels go, and nothing more is asked.
  await view(SOLLENTUNA, 1325);
  assert.equal(state.labels.length, 0);
  // Over the terminal itself, low: read.
  await view(BROMMA, 3000);
  assert.equal(state.urls.length, 2);
  // Twenty-odd kilometres south-east, high: out of reach.
  await view({ lat: 59.2, lon: 18.2 }, 30_000);
  assert.equal(state.urls.length, 2);
  assert.equal(state.labels.length, 0);
});

test('queue minutes over a quarter of an hour old are not shown', async (t) => {
  const { state, view, refresh } = harness(t);
  await view(BROMMA, 3000);
  assert.equal(state.labels.length, 1);
  // Swedavia stops answering and the route falls back on its last answer:
  // while that is recent the minutes stand…
  state.stale = true;
  state.updatedAt = NOW;
  await refresh();
  assert.equal(state.labels.length, 1);
  // …and after a quarter of an hour they go.
  for (let i = 0; i < 5; i += 1) await refresh();
  assert.equal(state.labels.length, 0);
  // Fresh again: back.
  state.stale = false;
  state.updatedAt = null;
  await refresh();
  assert.equal(state.labels.length, 1);
  // The route itself failing: the same quarter of an hour.
  state.down = true;
  for (let i = 0; i < 5; i += 1) await refresh();
  assert.equal(state.labels.length, 1);
  await refresh();
  assert.equal(state.labels.length, 0);
});

test('a page looked at again reads the queues at once', async (t) => {
  const { state, view, refresh } = harness(t);
  await view(BROMMA, 3000);
  assert.equal(state.urls.length, 1);
  // Hidden when the refresh falls due: skipped.
  state.hidden = true;
  await refresh();
  assert.equal(state.urls.length, 1);
  // Looked at again: read now, without the camera having to move.
  state.hidden = false;
  state.listeners.get('visibilitychange')();
  await settle();
  assert.equal(state.urls.length, 2);
});

test('each checkpoint is a marker under its label, in one set', async (t) => {
  const { state, view, markers } = harness(t);
  assert.equal(markers().items.size, 0);
  await view(BROMMA, 3000);
  const set = markers();
  assert.equal(set.kind, 'points');
  assert.equal(set.show, true);
  const [marker] = [...set.items.values()];
  assert.equal(marker.id, state.labels[0].id);
  assert.ok(marker.id.startsWith('airport-queue:BMA:'));
  assert.equal(marker.pos.lon, 17.94556);
  assert.equal(marker.pos.lat, 59.35553);
  assert.equal(marker.pixelSize, 9);
  assert.equal(marker.color, '#69f0ae', 'four minutes is short');
  assert.equal(marker.disableDepthTest, Number.POSITIVE_INFINITY);
  // The label sits at the marker.
  const at = fromDegrees(marker.pos.lon, marker.pos.lat, marker.pos.height);
  assert.deepEqual(state.labels[0].position, at);
  assert.equal(state.labels[0].title, '4 min');
  // In the cockpit they hide, and come back out of it.
  state.cockpit = true;
  await view(BROMMA, 3000);
  assert.equal(markers().show, false);
  assert.equal(markers().items.size, 0);
  state.cockpit = false;
  await view(BROMMA, 3000);
  assert.equal(markers().show, true);
  assert.equal(markers().items.size, 1);
});

test('a label or a marker clicked opens the board; anything else does not', async (t) => {
  const { state, view, markers, queues, camera } = harness(t);
  // No airport: a click on a stray queue id does nothing.
  state.picked = {
    set: 'airport-queues',
    id: 'airport-queue:BMA:1',
    surface: false,
  };
  state.click();
  assert.deepEqual(state.opened, []);
  await view(BROMMA, 3000);
  const [id] = markers().items.keys();
  // The marker under the click.
  state.picked = { set: 'airport-queues', id, surface: false };
  state.click();
  assert.deepEqual(state.opened, ['BMA']);
  // The label, before what is under it.
  state.picked = { set: 'hospitals', id: 'se-hospital:1', surface: false };
  state.labelHit = id;
  state.click();
  assert.deepEqual(state.opened, ['BMA', 'BMA']);
  // Something else, or the map.
  state.labelHit = null;
  state.click();
  state.picked = null;
  state.click();
  assert.deepEqual(state.opened, ['BMA', 'BMA']);
  // Gone: the set, the click and the camera listener with it.
  queues.destroy();
  assert.equal(markers(), undefined);
  assert.equal(state.click, null);
  assert.equal(camera.listenerCount('moveEnd'), 0);
});
