// Swedish fork: the ground floor's warm goes straight to the terrain
// service's paced queue (groundFloor.js `warmGroundFloor`), so a small warm,
// the ridden vehicle's cell, is not held behind a large one that is out: it
// rides the next request. The terrain service runs on the test's own clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroundFloor } from './groundFloor.js';
import { createTerrainHeights, REQUEST_GAP_MS } from './terrainHeights.js';
import { ensureGeoidReady } from '../data/geoid.js';

await ensureGeoidReady();

/**
 * The application's ground floor over the terrain service on a hand-run
 * clock, against a server answering every point after `rttMs`; each request
 * is kept with its start and its points.
 */
function surface({ rttMs, signal } = {}) {
  let at = 0;
  let id = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => {
    timers.set(++id, { fn, due: at + ms });
    return id;
  };
  const requests = [];
  const terrain = createTerrainHeights({
    signal,
    clock: () => at,
    setTimer,
    clearTimer: (key) => timers.delete(key),
    source: {
      getHeights(chunk) {
        requests.push({ at, keys: chunk.map((point) => point.key) });
        return new Promise((resolve) =>
          setTimer(() => resolve(chunk.map(() => ({ ellipsoid: 30 }))), rttMs),
        );
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  };
  // What the ground floor asks of the terrain service, counted.
  const asked = [];
  const counted = {
    ...terrain,
    resolveEllipsoidalGround(points, options) {
      asked.push(points.length);
      return terrain.resolveEllipsoidalGround(points, options);
    },
  };
  return {
    terrain,
    ground: createGroundFloor({ terrain: counted, signal }),
    asked,
    requests,
    timers,
    now: () => at,
    /** Run the timers due until `until` (ms) on the test's clock. */
    async run(until) {
      for (;;) {
        await settle();
        const due = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!due || due[1].due > until) break;
        timers.delete(due[0]);
        at = Math.max(at, due[1].due);
        due[1].fn();
      }
      at = until;
      await settle();
    },
  };
}

/** The scene: a transit warm of 288 cells and a Swedish layer asking 64 at a time. */
function busy({ terrain, ground }) {
  ground.warmGroundFloor(
    Array.from({ length: 288 }, (_, i) => ({
      lat: 59.3 + Math.floor(i / 20) * 0.001,
      lon: 18 + (i % 20) * 0.001,
    })),
  );
  let batch = 0;
  (async () => {
    while (batch < 50) {
      await terrain.resolveEllipsoidalGround(
        Array.from({ length: 64 }, (_, i) => ({
          lat: 60 + batch * 0.01,
          lon: 15 + i * 0.001,
        })),
      );
      batch += 1;
    }
  })().catch(() => {
    // The page's lifetime ended: the layer stops asking.
  });
}

const COCKPIT = { lat: 59.4, lon: 18.5 };

/** When (ms after its warm) the ridden vehicle's cell got its floor. */
async function cockpitLanded(scene) {
  await scene.run(2000);
  const warmedAt = scene.now();
  scene.ground.warmGroundFloor([COCKPIT]);
  for (let step = 0; step < 120; step += 1) {
    await scene.run(scene.now() + 250);
    if (scene.ground.cachedGroundFloor(COCKPIT.lat, COCKPIT.lon) != null)
      return scene.now() - warmedAt;
  }
  return Infinity;
}

test('the ridden vehicle’s cell rides the next request while a large warm is out', async () => {
  const scene = surface({ rttMs: 50 });
  busy(scene);
  const landedMs = await cockpitLanded(scene);
  // One pace step and the answer: it used to wait for the whole transit warm.
  assert.ok(landedMs <= REQUEST_GAP_MS + 250, `landed after ${landedMs} ms`);
  // And no request went sooner than the pace allows.
  await scene.run(scene.now() + 20_000);
  for (let i = 1; i < scene.requests.length; i += 1)
    assert.ok(
      scene.requests[i].at - scene.requests[i - 1].at >= REQUEST_GAP_MS,
    );
});

test('on a cold server it waits for the request out and its own, not the warm', async () => {
  const scene = surface({ rttMs: 6000 });
  busy(scene);
  const landedMs = await cockpitLanded(scene);
  assert.ok(landedMs <= 2 * 6000, `landed after ${landedMs} ms`);
});

test('a cell being warmed is not asked again by the warms that follow', async () => {
  const scene = surface({ rttMs: 3000 });
  for (let i = 0; i < 10; i += 1) {
    scene.ground.warmGroundFloor([COCKPIT]);
    await scene.run(scene.now() + 100);
  }
  await scene.run(scene.now() + 5000);
  assert.equal(scene.requests.length, 1);
  assert.equal(scene.requests[0].keys.length, 1);
  assert.deepEqual(scene.asked, [1], 'one call into the queue, not ten');
  assert.ok(scene.ground.cachedGroundFloor(COCKPIT.lat, COCKPIT.lon) != null);
  // Warm now, it is not asked at all.
  scene.ground.warmGroundFloor([COCKPIT]);
  await scene.run(scene.now() + 5000);
  assert.equal(scene.requests.length, 1);
});

test('after the page lifetime ends nothing is warmed and no timer is left', async () => {
  const lifetime = new AbortController();
  const scene = surface({ rttMs: 3000, signal: lifetime.signal });
  busy(scene);
  await scene.run(1500);
  lifetime.abort();
  // The stand-in server still answers the request that was out; after that,
  // none of the service's timers is left.
  await scene.run(scene.now() + 3000);
  assert.equal(scene.timers.size, 0);
  const sent = scene.requests.length;
  scene.ground.warmGroundFloor([COCKPIT]);
  await scene.run(scene.now() + 60_000);
  assert.equal(scene.requests.length, sent);
});
