import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_VIEW, flyToHome } from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToHome({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('a fresh load flies to Västerås and lands over the city', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const views = [];
  flyToHome({
    isDestroyed: () => false,
    camera: {
      setView: (view) => views.push(view),
      flyTo: (view) => views.push(view),
      cancelFlight() {},
    },
  });
  t.mock.timers.tick(1000);
  assert.equal(HOME_VIEW.name, 'Västerås');
  assert.equal(views.length, 2);
  // Cesium Cartesian3 (ECEF) back to degrees; geocentric latitude runs
  // ~0.2 deg below geodetic at 60 N, hence the looser latitude bound.
  const { x, y, z } = views[1].destination;
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  assert.ok(Math.abs(lon - 16.54) < 0.05, `lon ${lon}`);
  assert.ok(Math.abs(lat - 59.6) < 0.3, `lat ${lat}`);
});
