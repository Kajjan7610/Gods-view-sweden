// Swedish fork: the Vessels layer fetches the fleet models (the whole set:
// its catalog, types and every GLB) only once a vessel could be drawn as
// one, under the DISPLAY 3D toggle and within the models' keep distance,
// never when the layer starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { FLEET_MODEL_POLICY } from '../flights/policy.js';
import {
  fleetModelSet,
  fleetModelSetLoading,
  resetFleetModelSet,
} from '../../data/fleetModels.js';
import { fetchPublicFile } from '../../testSupport/fleetGlb.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { eastNorthUp } from '../../geo/frames.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { scale } from '../../geo/vector.js';

const noop = () => {};
/** Off Gothenburg. */
const SEA = Object.freeze({ lat: 57.6, lon: 11.6 });
const ENU = eastNorthUp(fromDegrees(SEA.lon, SEA.lat, 0));

/** A cargo ship at SEA, as an AIS row. */
const SHIP = Object.freeze({
  mmsi: '265000001',
  lat: SEA.lat,
  lon: SEA.lon,
  type: 70,
  speed: 12,
  course: 90,
  last_position_epoch: 1_000,
});

/**
 * A Vessels layer on fake renderer ports with a cargo ship at SEA (none
 * with `ship: false`; `reconcile()` brings it), the camera `eye.height`
 * metres straight above it, the DISPLAY 3D toggle in `display` and the
 * shared fleet-model service (3 km in, kept to 3.6 km). Every fetch is
 * served from public/ (503 while `network.up` is false) and listed in
 * `requests`; no fleet set is loaded at the start.
 */
function shipBelow(t, { height, ship = true }) {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(console, 'info', () => {});
  resetFleetModelSet();
  const requests = [];
  const network = { up: true };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return network.up ? fetchPublicFile(url) : { ok: false, status: 503 };
  };
  const realDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  const display = { models3d: true };
  const renders = [];
  const layer = createVesselLayer({
    source: { getSnapshot: async () => ({ records: [] }) },
    services: {
      context: {
        clearSelectedEntityContextForLayer: noop,
        registerEntityContext: () => null,
      },
      trails: {
        createTrail: () => ({ setPositions: noop, clear: noop, destroy: noop }),
      },
      labels: { formatKnots: (knots) => `${knots} kt` },
      picking: { registerPickOwner: noop, unregisterPickOwner: noop },
      overlay: {
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
        clearOverlaySource: noop,
      },
      // Turned on, the layer warms the geoid grid; the sea here is at 0.
      geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
      sprites: {},
      focus: {
        focusNowMs: () => clock,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
        forgetSpriteFocus: noop,
      },
      worldFocus: {},
      render: {
        holdContinuousRender: noop,
        releaseContinuousRender: noop,
        governorRequestRender: (reason) => renders.push(reason),
      },
      fleet: {
        policy: FLEET_MODEL_POLICY,
        display: () => ({
          models3d: display.models3d,
          models3dMode: 'proximity',
        }),
        resolveAsset: (url) => url,
      },
    },
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
  layer.testing._setVesselStateForTest({
    viewer,
    icons: null,
    interactionKeyTarget: new EventTarget(),
  });
  layer.testing._setAisRuntimeForTest({
    now: () => clock,
    setTimeout: () => 0,
    clearTimeout: noop,
  });
  // The icon set, the models, the pass before each frame.
  layer.init(viewer);
  const reconcile = () =>
    layer.testing._reconcileVesselsForTest(viewer, [{ ...SHIP }]);
  if (ship) reconcile();
  t.after(() => {
    layer.destroy(viewer);
    unbind();
    globalThis.fetch = realFetch;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
    resetFleetModelSet();
  });
  const visual = () =>
    layer.testing._vesselVisualForTest(
      layer.testing._vesselRecordForTest('265000001'),
    );
  const frame = () => {
    clock += 100;
    for (const cb of [...preRenders]) cb({ frame: 0 });
  };
  return {
    layer,
    viewer,
    draw,
    display,
    eye,
    network,
    requests,
    renders,
    visual,
    reconcile,
    /** How many times `file` (catalog.json, a GLB) was fetched. */
    fetched: (file) =>
      requests.filter((url) => url.endsWith(`/models/fleet/${file}`)).length,
    /** One frame, 100 ms after the last. */
    frame,
    /** `seconds` of frames, ten a second. */
    run(seconds) {
      for (let i = 0; i < seconds * 10; i += 1) frame();
    },
  };
}

test('Vessels fetches no fleet model while no vessel is near enough to draw as one', (t) => {
  const app = shipBelow(t, { height: 20_000 });
  app.run(5);
  assert.deepEqual(app.requests, [], 'started, 20 km up: nothing fetched');
  app.eye.height = 4_500;
  app.run(5);
  assert.deepEqual(
    app.requests,
    [],
    '4.5 km, past the 3.6 km keep distance and its margin: nothing',
  );
  app.display.models3d = false;
  app.eye.height = 800;
  app.run(5);
  assert.deepEqual(app.requests, [], '3D off: nothing');
  assert.equal(fleetModelSetLoading(), null, 'no load was started');
});

test('a vessel is looked for with the candidates’ margin: 4 km is near enough to ask', (t) => {
  // 1.2 × the 3.6 km keep distance, as the vessels near enough for a model
  // are gathered: one may come that much nearer before the next look.
  const app = shipBelow(t, { height: 4_000 });
  app.run(1);
  assert.equal(app.fetched('catalog.json'), 1);
});

test('a frame before the first vessels are in does not hold back the frame that brings them', (t) => {
  // Started 800 m above a moored ship: a frame runs before the first
  // snapshot's vessels are in, and the frame after them follows 100 ms on.
  const app = shipBelow(t, { height: 800, ship: false });
  app.frame();
  assert.deepEqual(app.requests, [], 'no vessel yet');
  app.reconcile();
  app.frame();
  assert.equal(app.fetched('catalog.json'), 1, 'asked on the next frame');
});

test('a load that fails is not asked again every frame, only when Vessels is next turned on', async (t) => {
  const app = shipBelow(t, { height: 800 });
  app.network.up = false;
  app.run(1);
  assert.equal(app.fetched('catalog.json'), 1);
  await assert.rejects(fleetModelSetLoading());
  app.run(5);
  assert.equal(app.fetched('catalog.json'), 1, 'not again while it stays on');
  app.network.up = true;
  app.layer.disable();
  await app.layer.enable(app.viewer);
  // Its next snapshot names the ship again.
  app.reconcile();
  app.run(1);
  assert.equal(
    app.fetched('catalog.json'),
    2,
    'turned on again: asked once more',
  );
  await fleetModelSetLoading();
  app.run(1);
  const models = app.draw.find('fleet-models:');
  for (const id of [...models.items.keys()]) app.draw.ready(models.spec.id, id);
  app.run(1);
  assert.equal(app.visual().modelOwnsVisual, true, 'drawn as its model');
});

test('a vessel within the keep distance loads the fleet set once, and its model then draws', async (t) => {
  const app = shipBelow(t, { height: 20_000 });
  app.run(2);
  app.eye.height = 800;
  app.run(1);
  assert.equal(app.fetched('catalog.json'), 1, 'the set is asked for');
  app.run(5);
  assert.equal(app.fetched('catalog.json'), 1, 'and only once');
  await fleetModelSetLoading();
  const count = Object.keys(fleetModelSet().catalog).length;
  assert.equal(
    app.requests.length,
    count + 2,
    'its catalog, its types and every model, each once',
  );
  assert.ok(
    app.renders.includes('ais-vessels-models'),
    'a frame is asked for once it is in',
  );
  app.run(1);
  const models = app.draw.find('fleet-models:');
  for (const id of [...models.items.keys()]) app.draw.ready(models.spec.id, id);
  app.run(1);
  assert.equal(app.visual().modelOwnsVisual, true, 'drawn as its model');
  app.run(5);
  assert.equal(app.requests.length, count + 2, 'nothing fetched again');
});

test('Vessels turned off before the set is asked for leaves nothing to fetch it', (t) => {
  const app = shipBelow(t, { height: 20_000 });
  app.run(2);
  app.layer.disable();
  app.eye.height = 800;
  app.run(5);
  assert.deepEqual(app.requests, []);
  assert.equal(fleetModelSetLoading(), null);
});
