import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStartView, START_VIEW, SWEDISH_START_VIEW } from '../camera.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';

function viewerRecording(views) {
  return bindFakeCesiumCamera({
    isDestroyed: () => false,
    camera: {
      setView(view) {
        views.push(view);
      },
      flyTo() {
        assert.fail('a start view is set, not flown to');
      },
    },
  });
}

test('the camera starts over the whole planet, looking straight down', () => {
  const views = [];
  applyStartView(viewerRecording(views));
  assert.equal(views.length, 1);
  assert.ok(START_VIEW.height >= 20000000, 'the whole planet is in view');
  assert.ok(Math.abs(views[0].orientation.pitch + Math.PI / 2) < 1e-9);
  assert.equal(views[0].orientation.heading, 0);
});

test('a host can start the camera at a city instead', () => {
  const views = [];
  applyStartView(viewerRecording(views), {
    lon: 2.35,
    lat: 48.86,
    height: 5000,
    heading: 90,
    pitch: -30,
  });
  assert.equal(views.length, 1);
  assert.ok(Math.abs(views[0].orientation.heading - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(views[0].orientation.pitch + Math.PI / 6) < 1e-9);
});

test('the Swedish fork starts over Västerås, looking north across it', () => {
  const views = [];
  applyStartView(viewerRecording(views), SWEDISH_START_VIEW);
  assert.equal(SWEDISH_START_VIEW.name, 'Västerås');
  assert.equal(views.length, 1);
  // Cesium Cartesian3 (ECEF) back to degrees; geocentric latitude runs
  // ~0.2 deg below geodetic at 60 N, hence the looser latitude bound.
  const { x, y, z } = views[0].destination;
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  assert.ok(Math.abs(lon - 16.54) < 0.05, `lon ${lon}`);
  assert.ok(Math.abs(lat - 59.6) < 0.3, `lat ${lat}`);
});
