import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { createController } from './controller.js';

const controller = (flightState = { feed: {} }) =>
  createController({ flightState, parts: {}, layer: {} });

/** A camera at `eye` (lon, lat, height) whose line of sight meets `ground`. */
function looking(eye, ground) {
  const position = fromDegrees(...eye);
  const target = fromDegrees(ground[0], ground[1], 0);
  const d = {
    x: target.x - position.x,
    y: target.y - position.y,
    z: target.z - position.z,
  };
  const length = Math.hypot(d.x, d.y, d.z);
  return fakeCameraPort({
    pose: {
      lon: eye[0],
      lat: eye[1],
      height: eye[2],
      position,
      direction: { x: d.x / length, y: d.y / length, z: d.z / length },
    },
  });
}

// Swedish fork: the flights are read around the look-at point, the map's
// centre, as the GNSS layer reads; before, around the point under the eye.
test('the feed is asked for the flights around the look-at point, the map’s centre', () => {
  const viewer = {};
  // The eye 80 km over Uppsala, looking at Stockholm.
  const camera = looking([17.64, 59.86, 80_000], [18.07, 59.33]);
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    const query = controller()._flightQuery(viewer);
    assert.ok(Math.abs(query.latitude - 59.33) < 1e-8, String(query.latitude));
    assert.ok(Math.abs(query.longitude - 18.07) < 1e-8);
    // Looking past the globe, the ground under the line of sight's closest
    // approach to the earth's centre (looking up and away, under the eye),
    // never the middle of a view rectangle that may be the whole globe.
    camera.setPose({ direction: { x: 0, y: 0, z: 1 } });
    camera.setViewRectangle({ west: -180, south: -90, east: 180, north: 90 });
    const under = controller()._flightQuery(viewer);
    assert.ok(Math.abs(under.latitude - 59.86) < 1e-8);
    assert.ok(Math.abs(under.longitude - 17.64) < 1e-8);
    // With no ground point under the eye, no area.
    camera.setPose({ lon: NaN, lat: NaN });
    assert.deepEqual(controller()._flightQuery(viewer), {}, 'no ground point');
  } finally {
    unbind();
  }
});

test('in Cockpit the flights are read around the camera’s ground point, the aircraft flown', () => {
  const viewer = {};
  // From the cockpit the line of sight runs to the horizon, far ahead.
  const camera = looking([18.07, 59.33, 11_000], [21, 60]);
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    const cockpit = { feed: {}, _cockpitContactMode: true };
    assert.deepEqual(controller(cockpit)._flightQuery(viewer), {
      latitude: 59.33,
      longitude: 18.07,
    });
    camera.setPose({ lon: 18.07, lat: NaN });
    assert.deepEqual(
      controller(cockpit)._flightQuery(viewer),
      {},
      'half a ground point: none',
    );
    // Leaving the cockpit, the look-at point again.
    cockpit._cockpitContactMode = false;
    camera.setPose({ lat: 59.33 });
    assert.ok(
      Math.abs(controller(cockpit)._flightQuery(viewer).longitude - 21) < 1e-8,
    );
  } finally {
    unbind();
  }
});

test('with no viewer or camera the query names no area', () => {
  const { _flightQuery } = controller();
  assert.deepEqual(_flightQuery(null), {});
  assert.deepEqual(_flightQuery(undefined), {});
  assert.deepEqual(_flightQuery({}), {}, 'a viewer with no camera');
  assert.deepEqual(
    _flightQuery({ isDestroyed: () => true, camera: {} }),
    {},
    'a destroyed viewer',
  );
  const cockpit = controller({ feed: {}, _cockpitContactMode: true });
  assert.deepEqual(cockpit._flightQuery({}), {}, 'in Cockpit too');
});

// Swedish fork: a wider view is asked for too, around the look-at point.
test('with a view rectangle the query names the ground in view around the look-at point; in Cockpit it never does', () => {
  const viewer = {};
  // High over Sweden, looking straight down at it.
  const camera = looking([16, 62, 2_000_000], [16, 62]);
  camera.setViewRectangle({ west: 4, south: 54, east: 30, north: 70 });
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    const query = controller()._flightQuery(viewer);
    assert.ok(Math.abs(query.latitude - 62) < 1e-6);
    assert.deepEqual(query.bbox, { west: 4, south: 54, east: 30, north: 70 });
    // A view of the whole globe says nothing of where it is: no box.
    camera.setViewRectangle({ west: -180, south: -90, east: 180, north: 90 });
    assert.equal('bbox' in controller()._flightQuery(viewer), false);
    camera.setViewRectangle({ west: 4, south: 54, east: 30, north: 70 });
    const cockpit = { feed: {}, _cockpitContactMode: true };
    assert.deepEqual(controller(cockpit)._flightQuery(viewer), {
      latitude: 62,
      longitude: 16,
    });
  } finally {
    unbind();
  }
});
