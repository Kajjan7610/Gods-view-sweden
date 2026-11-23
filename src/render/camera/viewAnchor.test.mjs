// Swedish fork: the look-at point the GNSS layer and the flights feed ask
// around, in views where the screen centre misses the globe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WGS84 } from '../../geo/ellipsoid.js';
import { bindRenderer } from '../rendererOf.js';
import { createStubRenderer } from '../stub/index.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { viewAnchor, viewExtent } from './viewAnchor.js';

const deg = Math.PI / 180;

function stubView() {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  const look = (lon, lat, height, pitchDeg) => {
    renderer.camera.setView({
      destination: { lon, lat, height },
      orientation: { heading: 0, pitch: pitchDeg * deg, roll: 0 },
    });
    return {
      anchor: viewAnchor(viewer),
      rectangle: renderer.camera.viewRectangle(),
    };
  };
  return look;
}

test('from space, past the limb, the anchor stays on the line of sight, never at 0°, 0°', () => {
  const look = stubView();
  let wholeGlobe = 0;
  for (const height of [2e6, 5e6, 1e7, 2e7]) {
    for (const pitch of [-80, -70, -60, -50, -40, -30, -20]) {
      const { anchor, rectangle } = look(18.07, 59.33, height, pitch);
      if (rectangle?.west === -180 && rectangle?.east === 180) wholeGlobe += 1;
      assert.ok(anchor, `${height} m, ${pitch}°`);
      assert.notDeepEqual(anchor, { latitude: 0, longitude: 0 });
      // Looking north, the line of sight stays in the eye's meridian plane.
      const onMeridian = [18.07, 18.07 - 180].some(
        (lon) => Math.abs(anchor.longitude - lon) < 1e-6,
      );
      assert.ok(onMeridian, `${height} m, ${pitch}°: ${anchor.longitude}`);
      assert.ok(anchor.latitude > 45, `${height} m, ${pitch}°`);
    }
  }
  assert.ok(wholeGlobe > 0, 'some of these views see the whole globe');
});

test('an eye below the ellipsoid reads the point under it, wherever it looks', () => {
  const look = stubView();
  for (const pitch of [-90, -45, -20, -10]) {
    const { anchor } = look(80.27, 13.08, -30, pitch);
    assert.ok(Math.abs(anchor.latitude - 13.08) < 1e-6, String(pitch));
    assert.ok(Math.abs(anchor.longitude - 80.27) < 1e-6, String(pitch));
  }
  // Just above it, the line of sight meets the ground ahead as usual.
  const { anchor } = look(80.27, 13.08, 50, -45);
  assert.ok(Math.abs(anchor.latitude - 13.08) < 0.01);
});

test('a ray that passes the globe by reads the ground under its closest approach', () => {
  const viewer = {};
  const r = WGS84.radii.x;
  // Twice the equatorial radius out at 0°, 0°, looking 45° east of inward:
  // it passes nearest the centre over 0°, 45° E, √2 radii out.
  const camera = fakeCameraPort({
    pose: {
      lon: 0,
      lat: 0,
      height: r,
      position: { x: 2 * r, y: 0, z: 0 },
      direction: { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
    },
  });
  camera.port.viewRectangle = () => ({
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    const anchor = viewAnchor(viewer);
    assert.ok(Math.abs(anchor.latitude) < 1e-9);
    assert.ok(Math.abs(anchor.longitude - 45) < 1e-9);
    // Looking away from the earth, the eye itself is nearest.
    camera.setPose({ direction: { x: 1, y: 0, z: 0 } });
    assert.deepEqual(
      Object.values(viewAnchor(viewer)).map((value) => Math.round(value)),
      [0, 0],
    );
  } finally {
    unbind();
  }
});

test('a port without a position goes by its view rectangle unless it spans every longitude', () => {
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { lon: 18.07, lat: 59.33, position: null },
    viewRectangle: { west: 17, south: 59, east: 19, north: 60 },
  });
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    const middle = viewAnchor(viewer);
    assert.ok(Math.abs(middle.latitude - 59.5) < 1e-9);
    assert.ok(Math.abs(middle.longitude - 18) < 1e-9);
    camera.setViewRectangle({ west: -180, south: -90, east: 180, north: 90 });
    assert.deepEqual(viewAnchor(viewer), { latitude: 59.33, longitude: 18.07 });
    camera.setPose({ lat: NaN });
    assert.equal(viewAnchor(viewer), null, 'no settled camera');
  } finally {
    unbind();
  }
  assert.equal(viewAnchor({}), null, 'no camera');
});

test('the ground in view is the view rectangle as it is, never one of the whole globe', () => {
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { lon: 16, lat: 62 },
    viewRectangle: { west: -20, south: 40, east: 60, north: 70 },
  });
  const unbind = bindRenderer(viewer, { camera: camera.port });
  try {
    // The server cuts it around the look-at point and says how much it read.
    assert.deepEqual(viewExtent(viewer), {
      west: -20,
      south: 40,
      east: 60,
      north: 70,
    });
    camera.setViewRectangle({ west: -180, south: -90, east: 180, north: 90 });
    assert.equal(viewExtent(viewer), null, 'the whole globe');
    camera.setViewRectangle({ west: 10, south: 60, east: 20, north: 55 });
    assert.equal(viewExtent(viewer), null, 'not a rectangle');
    camera.setViewRectangle(null);
    assert.equal(viewExtent(viewer), null, 'no rectangle');
  } finally {
    unbind();
  }
  assert.equal(viewExtent({}), null);
});
