// Swedish fork: the Rail layer fetches the fleet models (the whole set: its
// catalog, types and every GLB) only once a train could be drawn as one,
// under the DISPLAY 3D toggle and within the models' keep distance, never
// when the layer is turned on. Trains keep the aircraft distances.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RAIL_POLL_MS, railTrainKey } from './policy.js';
import { FLEET_MODEL_POLICY } from '../flights/policy.js';
import {
  fleetModelSet,
  fleetModelSetLoading,
  resetFleetModelSet,
} from '../../data/fleetModels.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';
import { fetchPublicFile } from '../../testSupport/fleetGlb.mjs';

const T1 = railTrainKey('mbta-rail', 'T1');

/**
 * The Rail layer, not yet turned on, its feed answering a train at Boston,
 * the camera `altitude` metres straight above it, the DISPLAY 3D toggle in
 * `display`, the shared fleet-model service with the aircraft distances
 * (3 km in, kept to 3.6 km). Every fetch is served from public/ and listed
 * in `requests`; no fleet set is loaded at the start.
 */
function railWithModels(t, { altitude }) {
  resetFleetModelSet();
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return fetchPublicFile(url);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    resetFleetModelSet();
  });
  const display = { models3d: true };
  const app = harness(t, {
    altitude,
    fleet: {
      policy: FLEET_MODEL_POLICY,
      display: () => ({
        models3d: display.models3d,
        models3dMode: 'proximity',
      }),
      resolveAsset: (url) => url,
    },
  });
  app.feeds.set('mbta-rail', () => [train('T1', BOSTON.lat, BOSTON.lon)]);
  return {
    app,
    display,
    requests,
    /** How many times `file` (catalog.json, a GLB) was fetched. */
    fetched: (file) =>
      requests.filter((url) => url.endsWith(`/models/fleet/${file}`)).length,
  };
}

/** {@link railWithModels}, turned on and polled: its train is drawn. */
async function trainBelow(t, options) {
  const rail = railWithModels(t, options);
  const { app } = rail;
  await app.enable();
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.ok(app.entry(T1)?.marker, 'the train is drawn');
  return rail;
}

test('Rail fetches no fleet model while no train is near enough to draw as one', async (t) => {
  const { app, display, requests } = await trainBelow(t, { altitude: 20_000 });
  app.run(5_000);
  assert.deepEqual(requests, [], 'turned on, 20 km up: nothing fetched');
  app.moveCameraQuietly({ altitude: 4_500 });
  app.run(5_000);
  assert.deepEqual(
    requests,
    [],
    '4.5 km, past the 3.6 km keep distance and its margin: nothing',
  );
  display.models3d = false;
  app.moveCameraQuietly({ altitude: 1_000 });
  app.run(5_000);
  assert.deepEqual(requests, [], '3D off: nothing');
  assert.equal(fleetModelSetLoading(), null, 'no load was started');
});

test('a train within the keep distance loads the fleet set once, and its model then draws', async (t) => {
  const { app, requests, fetched } = await trainBelow(t, { altitude: 20_000 });
  app.run(2_000);
  app.moveCameraQuietly({ altitude: 1_000 });
  app.run(1_000);
  assert.equal(fetched('catalog.json'), 1, 'the set is asked for');
  app.run(5_000);
  assert.equal(fetched('catalog.json'), 1, 'and only once');
  await fleetModelSetLoading();
  const count = Object.keys(fleetModelSet().catalog).length;
  assert.equal(
    requests.length,
    count + 2,
    'its catalog, its types and every model, each once',
  );
  assert.equal(new Set(requests).size, requests.length);
  // The model's load answers off the frame; the next frames place it.
  app.run(1_000);
  const models = app.drawn('models', '');
  for (const id of [...models.items.keys()]) app.draw.ready(models.spec.id, id);
  app.run(1_000);
  assert.equal(app.entry(T1).modelOwnsVisual, true, 'drawn as its model');
  assert.equal(app.entry(T1).marker.show, false, 'its icon hands over');
  app.run(5_000);
  assert.equal(requests.length, count + 2, 'nothing fetched again');
});

test('a frame before the first poll’s trains are in does not hold back the frame that brings them', async (t) => {
  // Turned on 1 km above a standing train: a frame runs while the first poll
  // is out, and the frame after its trains come in follows under 500 ms on.
  const { app, fetched } = railWithModels(t, { altitude: 1_000 });
  app.layer.enable(app.viewer);
  app.run(100, 100);
  assert.equal(app.entry(T1), undefined, 'the first poll is still out');
  await app.settle();
  await app.recheck();
  assert.ok(app.entry(T1)?.marker, 'its train is in');
  assert.equal(fetched('catalog.json'), 0);
  app.run(100, 100);
  assert.equal(fetched('catalog.json'), 1, 'asked on the next frame');
});

test('a train is looked for with the candidates’ margin: 4 km is near enough to ask', async (t) => {
  // 1.2 × the 3.6 km keep distance, as the trains near enough for a model
  // are gathered: one may come that much nearer before the next look.
  const { app, fetched } = await trainBelow(t, { altitude: 4_000 });
  app.run(1_000);
  assert.equal(fetched('catalog.json'), 1);
});

test('Rail turned off before the set is asked for leaves nothing to fetch it', async (t) => {
  const { app, requests } = await trainBelow(t, { altitude: 20_000 });
  app.run(2_000);
  app.layer.disable(app.viewer);
  app.moveCameraQuietly({ altitude: 1_000 });
  app.run(5_000);
  assert.deepEqual(requests, []);
  assert.equal(fleetModelSetLoading(), null);
});
