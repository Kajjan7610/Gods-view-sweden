// Swedish fork: the Transit layer as the application wires it. The fleet
// models (the whole set: its catalog, types and every GLB) are fetched only
// once a vehicle could be drawn as one, never when the layer is turned on;
// and a bus or tram turns from icon into model within Transit's own
// distances (300 m in, kept to 400 m), not the aircraft's 3 km, at which a
// bus is a few pixels across.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceServices } from '../surfaceServices.js';
import { createApplicationTransit } from './transit.js';
import {
  fleetModelSet,
  fleetModelSetLoading,
  loadFleetModelSet,
  resetFleetModelSet,
} from '../../data/fleetModels.js';
import { createTrack } from '../../data/contactPlayback.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
  uninstallRenderGovernor,
} from '../../renderGovernor.js';
import { fetchPublicFile } from '../../testSupport/fleetGlb.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { framePortFor } from '../../testSupport/fakeFramePort.mjs';
import { eastNorthUp } from '../../geo/frames.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { scale } from '../../geo/vector.js';

/** Open sea, where no transit feed runs: the layer polls nothing there. */
const SEA = Object.freeze({ lat: 30, lon: -40 });
const GROUND = fromDegrees(SEA.lon, SEA.lat, 0);
const ENU = eastNorthUp(GROUND);

/**
 * The application's Transit layer on fake renderer ports, the camera
 * `eye.height` metres straight above the buses a test puts on the ground at
 * SEA, the DISPLAY 3D toggle in `display`. Every fetch is served from
 * public/ and listed in `requests`; no fleet set is loaded at the start.
 * @param {import('node:test').TestContext} t
 * @param {{height: number}} options
 */
function harness(t, { height }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'info', () => {});
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  resetFleetModelSet();
  const requests = [];
  // `up: false` answers every request 503, as an unreachable server would.
  const network = { up: true };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return network.up ? fetchPublicFile(url) : { ok: false, status: 503 };
  };
  // The page the layer listens on for Escape and for being hidden.
  const realDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  });
  // The real render governor, on a fake frame port: what the layer asks of
  // it is read back from its diagnostics.
  const scene = {};
  installRenderGovernor(framePortFor(scene));
  const lifetime = new AbortController();
  const surface = createSurfaceServices({
    terrainSource: {
      getHeights: async (chunk) => chunk.map(() => ({ ellipsoid: 0 })),
    },
    signal: lifetime.signal,
    eventTarget: null,
  });
  const display = { models3d: true };
  const layer = createApplicationTransit({
    surface,
    displayParams: () => ({
      models3d: display.models3d,
      models3dMode: 'proximity',
    }),
    resolveAsset: (url) => url,
  });
  const eye = { height };
  const preRenders = new Set();
  const stock = () => ({ enabled: true, suppress: () => () => {} });
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({
        lon: SEA.lon,
        lat: SEA.lat,
        height: eye.height,
        heading: 0,
        pitch: -Math.PI / 2,
        roll: 0,
        position: fromDegrees(SEA.lon, SEA.lat, eye.height),
        direction: scale(ENU.z, -1),
        up: ENU.y,
        right: ENU.x,
        fovy: Math.PI / 3,
        aspectRatio: 1,
        near: 1,
        far: 5e8,
      }),
      viewRectangle: () => null,
      on: () => () => {},
    },
    frame: {
      on(phase, cb) {
        if (phase !== 'preRender') return () => {};
        preRenders.add(cb);
        return () => preRenders.delete(cb);
      },
      requestRender() {},
    },
    input: {
      on: () => () => {},
      isPointerFree: () => true,
      suspendCameraControls: () => () => {},
      behaviours: { select: stock(), dblclickFollow: stock() },
    },
  });
  layer.init(viewer);
  t.after(() => {
    layer.destroy(viewer);
    unbind();
    uninstallRenderGovernor(framePortFor(scene));
    _resetRenderGovernorForTest();
    lifetime.abort();
    globalThis.fetch = realFetch;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
    resetFleetModelSet();
  });
  const state = layer._transitStateForTest();
  const { rendering } = layer._transitPartsForTest();
  const models = () => draw.find('fleet-models:');
  return {
    layer,
    viewer,
    display,
    eye,
    network,
    requests,
    /** How many times `file` (catalog.json, types.json, a GLB) was fetched. */
    fetched: (file) =>
      requests.filter((url) => url.endsWith(`/models/fleet/${file}`)).length,
    /** A bus placed and in view on the ground under the camera. */
    bus(key) {
      const entry = {
        key,
        mode: 'bus',
        toCart: GROUND,
        track: createTrack(),
        hasRendered: true,
        heightPending: false,
        surfaceReady: true,
        courseDeg: 90,
      };
      rendering.addMarker(key, entry);
      entry.marker.show = true;
      state._vehicles.set(key, entry);
      state._visible.add(entry);
      return entry;
    },
    /** `count` frames 100 ms apart: past the models' 80 ms eligibility cadence. */
    frames(count = 1) {
      for (let i = 0; i < count; i += 1) {
        clock += 100;
        for (const cb of [...preRenders]) cb({ frame: 0 });
      }
    },
    /** Whether the layer runs a pass before each frame. */
    listening: () => preRenders.size > 0,
    /** Answer the load of every model the layer has placed, as the renderer does. */
    ready() {
      const set = models();
      for (const id of set ? [...set.items.keys()] : [])
        draw.ready(set.spec.id, id);
    },
    /** Whether `key` is drawn as its model now. */
    modeled: (key) => models()?.items.get(key)?.show === true,
    /** Why frames were asked for, oldest first. */
    renderReasons: () =>
      getRenderGovernorDiagnostics().recentRequests.map(({ reason }) => reason),
  };
}

/** Frames, the models' loads answered, frames: what the next second shows. */
function settle(app) {
  app.frames(3);
  app.ready();
  app.frames(3);
}

test('Transit fetches no fleet model while no vehicle is near enough to draw as one', (t) => {
  const app = harness(t, { height: 20_000 });
  app.layer.enable(app.viewer);
  const bus = app.bus('sea:bus-1');
  app.frames(10);
  assert.deepEqual(app.requests, [], 'turned on, 20 km up: nothing fetched');
  app.eye.height = 1_500;
  app.frames(10);
  assert.deepEqual(app.requests, [], 'past the 400 m keep distance: nothing');
  // Near, with the DISPLAY 3D toggle off: nothing either.
  app.display.models3d = false;
  app.eye.height = 200;
  app.frames(10);
  assert.deepEqual(app.requests, [], '3D off: nothing');
  assert.equal(fleetModelSetLoading(), null, 'no load was started');
  assert.equal(bus.marker.show, true, 'the bus keeps its icon');
  assert.equal(bus.modelOwnsVisual ?? false, false);
});

test('a vehicle coming within the keep distance loads the fleet set once, and its model then draws', async (t) => {
  const app = harness(t, { height: 5_000 });
  app.layer.enable(app.viewer);
  const bus = app.bus('sea:bus-1');
  app.frames(5);
  assert.deepEqual(app.requests, []);
  // 350 m: inside the keep distance, outside the add distance. The set is
  // asked for here, ahead of the first model.
  app.eye.height = 350;
  app.frames(1);
  assert.equal(app.fetched('catalog.json'), 1, 'the set is asked for');
  app.frames(20);
  assert.equal(app.fetched('catalog.json'), 1, 'and only once');
  await fleetModelSetLoading();
  const names = Object.keys(fleetModelSet().catalog);
  assert.ok(names.length > 100, 'the whole set');
  assert.equal(app.fetched('types.json'), 1);
  assert.equal(
    app.requests.length,
    names.length + 2,
    'its catalog, its types and every model, each once',
  );
  assert.equal(new Set(app.requests).size, app.requests.length);
  assert.ok(
    app.renderReasons().includes('transit-models'),
    'a frame is asked for once it is in',
  );
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), false, 'at 350 m it is still an icon');
  assert.equal(bus.marker.show, true);
  app.eye.height = 200;
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), true, 'at 200 m, its model');
  assert.equal(bus.marker.show, false, 'its icon hands over');
  app.frames(20);
  assert.equal(app.requests.length, names.length + 2, 'nothing fetched again');
});

test('a vehicle of no known mode asks for no fleet set: it never draws as a model', (t) => {
  const app = harness(t, { height: 200 });
  app.layer.enable(app.viewer);
  const entry = app.bus('sea:unknown-1');
  entry.mode = 'unknown';
  app.frames(10);
  assert.deepEqual(app.requests, []);
});

test('Transit turned off before the set is asked for leaves nothing to fetch it', (t) => {
  const app = harness(t, { height: 5_000 });
  app.layer.enable(app.viewer);
  app.bus('sea:bus-1');
  app.frames(5);
  app.layer.disable(app.viewer);
  assert.equal(app.listening(), false, 'no pass before frames is left');
  app.eye.height = 200;
  app.frames(10);
  assert.deepEqual(app.requests, []);
  assert.equal(fleetModelSetLoading(), null);
});

test('a load still running when Transit is turned off asks for no frame when it lands', async (t) => {
  const app = harness(t, { height: 200 });
  app.layer.enable(app.viewer);
  app.bus('sea:bus-1');
  app.frames(1);
  assert.equal(app.fetched('catalog.json'), 1);
  app.layer.disable(app.viewer);
  await fleetModelSetLoading();
  assert.ok(!app.renderReasons().includes('transit-models'));
  // On again, a bus near: drawn from the set already in, fetched once.
  app.layer.enable(app.viewer);
  app.bus('sea:bus-2');
  settle(app);
  assert.equal(app.modeled('sea:bus-2'), true);
  assert.equal(app.fetched('catalog.json'), 1);
});

test('a load that fails is not asked again every frame, only when Transit is next turned on', async (t) => {
  const app = harness(t, { height: 200 });
  app.network.up = false;
  app.layer.enable(app.viewer);
  const bus = app.bus('sea:bus-1');
  app.frames(1);
  assert.equal(app.fetched('catalog.json'), 1);
  await assert.rejects(fleetModelSetLoading());
  app.frames(30);
  assert.equal(app.fetched('catalog.json'), 1, 'not again while it stays on');
  assert.equal(bus.marker.show, true, 'the bus keeps its icon');
  app.network.up = true;
  app.layer.disable(app.viewer);
  app.layer.enable(app.viewer);
  app.bus('sea:bus-2');
  app.frames(1);
  assert.equal(
    app.fetched('catalog.json'),
    2,
    'turned on again: asked once more',
  );
  await fleetModelSetLoading();
  settle(app);
  assert.equal(app.modeled('sea:bus-2'), true);
});

test('a set another layer is loading (Flights loads it when turned on) is shared, not fetched again', async (t) => {
  const app = harness(t, { height: 200 });
  // As src/layers/flights/lifecycle.js does on enable.
  const flights = loadFleetModelSet({ resolveAsset: (url) => url });
  app.layer.enable(app.viewer);
  app.bus('sea:bus-1');
  app.frames(5);
  await flights;
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), true);
  assert.equal(app.fetched('catalog.json'), 1, 'one load for both layers');
  assert.equal(
    app.requests.length,
    Object.keys(fleetModelSet().catalog).length + 2,
  );
});

test('a bus 2 km away keeps its icon; at 200 m it is its model, kept to 400 m', async (t) => {
  const app = harness(t, { height: 2_000 });
  // The set is in already (another layer loaded it).
  await loadFleetModelSet({ resolveAsset: (url) => url });
  app.layer.enable(app.viewer);
  const bus = app.bus('sea:bus-1');
  settle(app);
  // Under the aircraft distances (3 km) it would be a model here, a few
  // pixels across.
  assert.equal(app.modeled('sea:bus-1'), false, '2 km: no model');
  assert.equal(bus.marker.show, true, 'its icon stays');
  app.eye.height = 200;
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), true, '200 m: its model');
  assert.equal(bus.modelOwnsVisual, true);
  assert.equal(bus.marker.show, false);
  app.eye.height = 380;
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), true, 'kept at 380 m');
  app.eye.height = 450;
  settle(app);
  assert.equal(app.modeled('sea:bus-1'), false, 'past 400 m: dropped');
  assert.equal(bus.marker.show, true, 'its icon is back');
});
