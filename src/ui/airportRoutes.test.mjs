// Today's routes: how wide an arc is drawn and how it rises off the globe,
// the arcs and destinations drawn, the overview flown to, and a destination
// clicked opening the board on its flights.
import assert from 'node:assert/strict';
import test from 'node:test';
import { toLonLatH } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import {
  arcPositions,
  createAirportRoutes,
  overview,
  routeWidth,
} from './airportRoutes.js';

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
  const top = (points) => Math.max(...points.map((p) => toLonLatH(p).height));
  const short = arcPositions(arn, hel, 20);
  assert.equal(short.length, 21);
  const ends = [short[0], short.at(-1)].map((p) => toLonLatH(p));
  assert.ok(Math.abs(ends[0].height) < 1 && Math.abs(ends[1].height) < 1);
  assert.ok(Math.abs(ends[1].lon - hel.lon) < 1e-6);
  assert.ok(Math.abs(ends[0].lat - arn.lat) < 1e-6);
  // Its middle is the top of the lift: 60 m for each of the ~400 km flown.
  const middle = toLonLatH(short[10]);
  assert.ok(middle.height > 23_500 && middle.height < 24_500);
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

const DAY = {
  airport: { iata: 'ARN', name: 'Stockholm Arlanda', lat: 59.65, lon: 17.92 },
  routes: [
    {
      iata: 'HEL',
      place: { sv: 'Helsingfors', en: 'Helsinki' },
      lat: 60.32,
      lon: 24.96,
      flights: 13,
    },
    { iata: 'LPA', place: null, lat: 27.93, lon: -15.39, flights: 1 },
  ],
};
const settle = async () => {
  for (let i = 0; i < 4; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function harness(t) {
  t.mock.method(console, 'warn', () => {});
  const state = {
    labels: [],
    visible: null,
    published: [],
    opened: [],
    flights: [],
    labelHit: null,
    picked: null,
    click: null,
  };
  const host = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort();
  camera.port.flyTo = (destination, options) => {
    state.flights.push({ destination, options });
    return { done: Promise.resolve('complete'), cancel() {} };
  };
  const { draw } = bindFakeDraw(host, { camera: camera.port });
  const routes = createAirportRoutes({
    viewer: host,
    overlayHost: {
      setEntries: (sourceId, entries) => {
        assert.equal(sourceId, 'airport-route-labels');
        state.labels = entries;
      },
      setVisible: (sourceId, visible) => (state.visible = visible),
      clearSource: () => (state.labels = []),
      hitTest: () => (state.labelHit ? { entryId: state.labelHit } : null),
    },
    publish: (view) => state.published.push(view),
    openBoard: (iata, query) => state.opened.push([iata, query]),
    fetchImpl: async () => ({ ok: true, json: async () => DAY }),
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({ screenPosition: { x: 1, y: 1 }, topHit: state.picked });
        return () => (state.click = null);
      },
    }),
  });
  t.after(() => routes.destroy());
  return {
    state,
    routes,
    arcs: () => draw.set('airport-routes'),
    dots: () => draw.set('airport-route-dots'),
  };
}

test('the routes are arcs in space and dots with names, then the overview', async (t) => {
  const { state, routes, arcs, dots } = harness(t);
  assert.equal(arcs().kind, 'lines');
  assert.equal(dots().kind, 'points');
  assert.equal(arcs().items.size, 0);
  await routes.show('ARN');
  await settle();
  const hel = arcs().items.get('airport-route:HEL');
  assert.equal(hel.mode, '3d', 'above the ground, not along it');
  assert.equal(hel.widthPx, routeWidth(13));
  assert.equal(hel.style.kind, 'glow');
  assert.equal(hel.style.power, 0.18);
  assert.equal(hel.style.color[3], 0.75);
  assert.equal(hel.positions.length, 49);
  assert.deepEqual(hel.positions, arcPositions(DAY.airport, DAY.routes[0]));
  assert.equal(arcs().items.get('airport-route:LPA').widthPx, 1.5);
  const dot = dots().items.get('airport-route:HEL:point');
  assert.deepEqual(dot.pos, { lon: 24.96, lat: 60.32, height: 0 });
  assert.equal(dot.pixelSize, 6);
  assert.equal(dot.color, '#ffc94d');
  assert.equal(dot.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(
    state.labels.map((label) => label.title),
    ['Helsinki · 13', 'LPA · 1'],
  );
  assert.equal(state.visible, true);
  assert.equal(state.published.at(-1).iata, 'ARN');
  // Straight down over the routes, in two and a half seconds.
  assert.equal(state.flights.length, 1);
  const [{ destination, options }] = state.flights;
  const view = overview(DAY);
  assert.deepEqual(destination, {
    lon: view.lon,
    lat: view.lat,
    height: view.height,
  });
  assert.equal(options.orientation.pitch, -Math.PI / 2);
  assert.equal(options.orientation.heading, 0);
  assert.equal(options.durationS, 2.5);
  // Hidden: nothing drawn, nothing published.
  routes.hide();
  assert.equal(arcs().items.size, 0);
  assert.equal(dots().items.size, 0);
  assert.equal(state.labels.length, 0);
  assert.equal(state.visible, false);
  assert.equal(state.published.at(-1), null);
});

test('a destination clicked opens the board on its flights', async (t) => {
  const { state, routes, arcs, dots } = harness(t);
  // Nothing shown: no click is ours.
  state.picked = { set: 'airport-route-dots', id: 'airport-route:HEL:point' };
  state.click();
  assert.deepEqual(state.opened, []);
  await routes.show('ARN');
  await settle();
  // Its dot, its arc and its name.
  state.click();
  state.picked = { set: 'airport-routes', id: 'airport-route:LPA' };
  state.click();
  state.picked = null;
  state.labelHit = 'airport-route:HEL';
  state.click();
  assert.deepEqual(state.opened, [
    ['ARN', 'HEL'],
    ['ARN', 'LPA'],
    ['ARN', 'HEL'],
  ]);
  // A destination not flown to today, another layer's dot, or the map.
  state.labelHit = null;
  state.picked = { set: 'airport-routes', id: 'airport-route:XXX' };
  state.click();
  state.picked = { set: 'hospitals', id: 'se-hospital:1' };
  state.click();
  state.picked = null;
  state.click();
  assert.equal(state.opened.length, 3);
  routes.destroy();
  assert.equal(arcs(), undefined);
  assert.equal(dots(), undefined);
  assert.equal(state.click, null);
  assert.equal(state.published.at(-1), null);
});
