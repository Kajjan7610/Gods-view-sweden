// Today's routes: how wide an arc is drawn and how it rises off the globe.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { arcPositions, overview, routeWidth } from './airportRoutes.js';

test('one flight is a hairline, a busy route a ribbon, capped', () => {
  assert.equal(routeWidth(1), 1.5);
  assert.ok(routeWidth(4) > routeWidth(2));
  assert.equal(routeWidth(100), 7);
  assert.equal(routeWidth(0), 1.5);
});

test('an arc leaves and lands on the ground and rises with the distance', () => {
  const arn = { lat: 59.6519, lon: 17.9186 };
  const hel = { lat: 60.3172, lon: 24.9633 };
  const lpa = { lat: 27.9319, lon: -15.3866 };
  const top = (points) =>
    Math.max(...points.map((p) => Cesium.Cartographic.fromCartesian(p).height));
  const short = arcPositions(arn, hel, 20);
  assert.equal(short.length, 21);
  const ends = [short[0], short.at(-1)].map((p) =>
    Cesium.Cartographic.fromCartesian(p),
  );
  assert.ok(Math.abs(ends[0].height) < 1 && Math.abs(ends[1].height) < 1);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(ends[1].longitude) - hel.lon) < 1e-6,
  );
  assert.ok(
    top(arcPositions(arn, lpa, 20)) > top(short) * 5,
    'a long flight rises higher',
  );
});

test('the overview looks down on the routes, weighted by flights', () => {
  const view = overview({
    airport: { lat: 59.65, lon: 17.92 },
    routes: [
      { lat: 60.32, lon: 24.96, flights: 13 },
      { lat: 55.62, lon: 12.66, flights: 9 },
      { lat: 36.68, lon: -4.5, flights: 6 },
      { lat: 27.93, lon: -15.39, flights: 6 },
    ],
  });
  assert.ok(view.lat > 45 && view.lat < 55, `centre latitude ${view.lat}`);
  assert.ok(view.lon > 5 && view.lon < 15, `centre longitude ${view.lon}`);
  assert.ok(view.height >= 2_250_000 && view.height <= 12_000_000);
});
