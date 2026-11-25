// Swedish fork: a transit floor pass warms its cold cells in one call, and
// through the application's ground floor and terrain service that is one
// paced request per 64 cells (height.js, services/terrainHeights.js). It used
// to warm them eight at a time. The selected (or ridden) vehicle's own cells
// go first, in a call of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeight } from './height.js';
import { FLOOR_WARM_PER_POLL, HEIGHT_SAMPLE_MAX_ALTITUDE_M } from './policy.js';
import { createGroundFloor } from '../../services/groundFloor.js';
import {
  createTerrainHeights,
  REQUEST_GAP_MS,
} from '../../services/terrainHeights.js';

/** The latitude of vehicle `v`'s cells. */
const latOf = (v) => 59.3 + v * 0.01;

/**
 * Vehicles in view, each offering `cellsEach` cells of its own, all cold;
 * vehicle `selected` is the selected one.
 */
function floorPass({ vehicles, cellsEach, ground, selected = null }) {
  const state = {
    _enabled: true,
    _viewer: null,
    _vehicles: new Map(),
    _visible: new Set(),
    _selectedKey: selected === null ? null : `trafiklab-sl:${selected}`,
    _viewBounds: null,
    _visibilityDirty: false,
    _floorTimer: null,
    _floorAttempts: 0,
    _floorCursor: 0,
    _heightDirty: new Set(),
  };
  const services = { render: { governorRequestRender() {} }, ground };
  const parts = {
    rendering: {
      // Over the 3D tiles: the globe is hidden, every cell needs the server.
      cameraHeightM: () => HEIGHT_SAMPLE_MAX_ALTITUDE_M / 10,
      globeSurface: () => 'none',
      sampleMeshFloors() {},
      requestVisibility() {},
    },
  };
  // Each vehicle's path walks its own cells, as trails.js offers them.
  parts.trails = {
    prepareEntry(entry, collect) {
      if (!collect) return;
      for (const point of entry.path)
        collect(point, parts.height.requestHeight(point.lat, point.lon, entry));
    },
  };
  parts.height = createHeight({ state, services, parts });
  for (let v = 0; v < vehicles; v += 1) {
    const path = Array.from({ length: cellsEach }, (_, c) => ({
      lat: latOf(v),
      lon: 18 + c * 0.002,
    }));
    const entry = { key: `trafiklab-sl:${v}`, path, fixes: [path.at(-1)] };
    state._vehicles.set(entry.key, entry);
    state._visible.add(entry);
  }
  return parts.height;
}

/** A ground service that only records what it is asked to warm. */
function recordingGround() {
  const calls = [];
  return {
    calls,
    GROUND_FLOOR_LIFT_M: 1.5,
    coarseFloorCoord: (lat, lon) => ({
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3)),
    }),
    cachedGroundFloor: () => null,
    neighborFloorM: () => null,
    warmGroundFloor: (points) => calls.push(points),
  };
}

/**
 * The application's ground floor over the terrain service, on a clock the
 * test runs; every request is kept with its start and its points.
 */
function pacedGround() {
  let at = 0;
  let id = 0;
  const timers = new Map();
  const requests = [];
  const terrain = createTerrainHeights({
    source: {
      async getHeights(chunk) {
        requests.push({ at, lats: chunk.map((point) => point.lat) });
        return chunk.map(() => ({ ellipsoid: 40 }));
      },
    },
    clock: () => at,
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, due: at + ms });
      return id;
    },
    clearTimer: (key) => timers.delete(key),
  });
  return {
    ground: createGroundFloor({ terrain }),
    requests,
    /** Run the queue's timers on its own clock until it is done. */
    async drain() {
      for (let turn = 0; turn < 100; turn += 1) {
        for (let i = 0; i < 4; i += 1)
          await new Promise((r) => setImmediate(r));
        const due = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        timers.delete(due[0]);
        at = Math.max(at, due[1].due);
        due[1].fn();
      }
    },
  };
}

test('a floor pass warms its cold cells in one call, not slices of 8', (t) => {
  const ground = recordingGround();
  const height = floorPass({ vehicles: 10, cellsEach: 5, ground });
  t.after(() => height.clear());
  height.anchorFloors();
  assert.deepEqual(
    ground.calls.map((call) => call.length),
    [50],
  );
});

test('a pass past the per-poll budget still warms in one call, the budget at most', (t) => {
  const ground = recordingGround();
  const height = floorPass({ vehicles: 100, cellsEach: 6, ground });
  t.after(() => height.clear());
  height.anchorFloors();
  assert.deepEqual(
    ground.calls.map((call) => call.length),
    [FLOOR_WARM_PER_POLL],
  );
});

test('the selected vehicle’s cold cells go first, in a warm call of their own', (t) => {
  const ground = recordingGround();
  const height = floorPass({ vehicles: 10, cellsEach: 5, ground, selected: 3 });
  t.after(() => height.clear());
  height.anchorFloors();
  assert.deepEqual(
    ground.calls.map((call) => call.length),
    [5, 45],
  );
  assert.ok(ground.calls[0].every((cell) => cell.lat === latOf(3)));
  assert.ok(ground.calls[1].every((cell) => cell.lat !== latOf(3)));
});

test('at most twelve of them; the rest of its cells go with the others', (t) => {
  const ground = recordingGround();
  const height = floorPass({ vehicles: 3, cellsEach: 20, ground, selected: 0 });
  t.after(() => height.clear());
  height.anchorFloors();
  assert.deepEqual(
    ground.calls.map((call) => call.length),
    [12, 48],
  );
  assert.ok(ground.calls[0].every((cell) => cell.lat === latOf(0)));
});

test('300 cold cells reach the terrain route as 5 requests, a second apart', async (t) => {
  const paced = pacedGround();
  const height = floorPass({
    vehicles: 100,
    cellsEach: 6,
    ground: paced.ground,
  });
  t.after(() => height.clear());
  height.anchorFloors();
  await paced.drain();
  assert.deepEqual(
    paced.requests.map((request) => request.lats.length),
    [64, 64, 64, 64, 44],
  );
  for (let i = 1; i < paced.requests.length; i += 1)
    assert.ok(
      paced.requests[i].at - paced.requests[i - 1].at >= REQUEST_GAP_MS,
    );
});

test('the selected vehicle’s floor is the first request, alone, at once', async (t) => {
  const paced = pacedGround();
  const height = floorPass({
    vehicles: 100,
    cellsEach: 6,
    ground: paced.ground,
    selected: 7,
  });
  t.after(() => height.clear());
  height.anchorFloors();
  await paced.drain();
  const [first, ...rest] = paced.requests;
  assert.equal(first.at, 0);
  assert.deepEqual(first.lats, Array(6).fill(latOf(7)));
  assert.deepEqual(
    rest.map((request) => request.lats.length),
    [64, 64, 64, 64, 38],
  );
  assert.ok(rest.every((request) => !request.lats.includes(latOf(7))));
});
