// Trafikverket's travel times and detectors as the queues layer and the city
// dossier read them.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_NORMAL_FLOW,
  normalizeQueueSnapshot,
  normalizeTrafficFlow,
  normalizeTravelTimeRoute,
  pointStatus,
  queueColor,
  queuesNear,
} from './records.js';

const NOW = Date.parse('2026-11-18T10:20:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

const stretch = (overrides = {}) => ({
  Id: '674',
  Name: 'Sotartunneln',
  TrafficStatus: 'heavy',
  TravelTime: 80.8,
  FreeFlowTravelTime: 31,
  Speed: 25.9,
  Length: 580,
  MeasureTime: at(2),
  Geometry: { WGS84: 'LINESTRING (18.05 59.31, 18.06 59.312, 18.07 59.314)' },
  ...overrides,
});

const lane = (overrides = {}) => ({
  SiteId: 2164,
  MeasurementSide: 'westBound',
  VehicleType: 'anyVehicle',
  VehicleFlowRate: 780,
  AverageVehicleSpeed: 22,
  MeasurementTime: at(1),
  DataQuality: 'good',
  CountyNo: 14,
  Geometry: { WGS84: 'POINT (11.98984 57.72835)' },
  BaselineTraffic: {
    Flow: { Mean: 646, StdDev: 80 },
    Speed: { Mean: 68.9, StdDev: 1.3 },
  },
  ...overrides,
});

test('a stretch keeps Trafikverket’s verdict, its delay and its line', () => {
  const route = normalizeTravelTimeRoute(stretch(), NOW);
  assert.equal(route.status, 'heavy');
  assert.equal(route.delayS, 50);
  assert.equal(route.normalS, 31);
  assert.equal(route.lines.length, 1);
  // Trafikverket's normal for the hour wins over the signposted speed.
  assert.equal(
    normalizeTravelTimeRoute(stretch({ ExpectedFreeFlowTravelTime: 60 }), NOW)
      .delayS,
    21,
  );
});

test('an old measurement says nothing about now', () => {
  const route = normalizeTravelTimeRoute(stretch({ MeasureTime: at(45) }), NOW);
  assert.equal(route.status, 'unknown');
  assert.equal(route.delayS, null);
  assert.equal(route.speedKmh, null);
  assert.equal(normalizeTravelTimeRoute(stretch({ Deleted: true }), NOW), null);
  assert.equal(
    normalizeTravelTimeRoute(
      stretch({ Geometry: { WGS84: 'POINT (1 2)' } }),
      NOW,
    ),
    null,
  );
});

test('the lanes of one place and direction are read as one measuring point', () => {
  const points = normalizeTrafficFlow(
    [
      lane(),
      // The next lane a few metres away, same direction.
      lane({
        SiteId: 2165,
        VehicleFlowRate: 1140,
        AverageVehicleSpeed: 29.1,
        Geometry: { WGS84: 'POINT (11.98987 57.72838)' },
        BaselineTraffic: {
          Flow: { Mean: 870, StdDev: 90 },
          Speed: { Mean: 62.4, StdDev: 1.5 },
        },
      }),
      // The other direction at the same place.
      lane({
        SiteId: 2170,
        MeasurementSide: 'eastBound',
        AverageVehicleSpeed: 70,
      }),
      // Bad data, too old, and outside Sweden are left out.
      lane({ SiteId: 1, DataQuality: 'bad' }),
      lane({ SiteId: 2, MeasurementTime: at(30) }),
      lane({ SiteId: 3, Geometry: { WGS84: 'POINT (2.35 48.85)' } }),
    ],
    NOW,
  );
  assert.equal(points.length, 2);
  const west = points.find((point) => point.side === 'westBound');
  assert.equal(west.id, '2164');
  assert.equal(west.lanes, 2);
  assert.equal(west.flow, 1920);
  assert.equal(west.normalFlow, 1516);
  // Weighted by flow: (22·780 + 29.1·1140) / 1920.
  assert.equal(west.speed, 26.2);
  assert.equal(west.status, 'queue');
  // The worst first.
  assert.equal(points[0], west);
  assert.equal(points[1].status, 'normal');
});

test('a slow car on an all but empty road, or no speed at all, is no queue', () => {
  const normal = { normalSpeed: 70, speedStdDev: 2, normalFlow: 600 };
  assert.equal(pointStatus({ ...normal, speed: 30 }), 'queue');
  assert.equal(pointStatus({ ...normal, speed: 50 }), 'slow');
  assert.equal(pointStatus({ ...normal, speed: 60 }), 'normal');
  // Under three quarters but within the normal spread: not slow.
  assert.equal(
    pointStatus({ ...normal, speed: 50, speedStdDev: 12 }),
    'normal',
  );
  assert.equal(
    pointStatus({ ...normal, speed: 30, normalFlow: MIN_NORMAL_FLOW - 1 }),
    'unknown',
  );
  assert.equal(pointStatus({ ...normal, speed: 69, normalFlow: 4 }), 'normal');
  assert.equal(pointStatus({ ...normal, speed: 0 }), 'unknown');
  assert.equal(
    pointStatus({ ...normal, speed: 50, normalSpeed: null }),
    'unknown',
  );
  assert.equal(queueColor('queue'), queueColor('congested'));
  assert.equal(queueColor('slow'), queueColor('heavy'));
});

test('the dossier lists the stretches near the town that do not flow freely', () => {
  const snapshot = normalizeQueueSnapshot(
    {
      RESPONSE: {
        RESULT: [
          {
            TravelTimeRoute: [
              stretch(),
              stretch({
                Id: '1',
                Name: 'E4 N Kista',
                TrafficStatus: 'freeflow',
              }),
              stretch({
                Id: '2',
                Name: 'Malmö',
                TrafficStatus: 'congested',
                Geometry: { WGS84: 'LINESTRING (13.0 55.6, 13.01 55.61)' },
              }),
            ],
          },
          { TrafficFlow: [lane()] },
        ],
      },
    },
    NOW,
  );
  // Worst first.
  assert.deepEqual(
    snapshot.routes.map((route) => route.status),
    ['congested', 'heavy', 'freeflow'],
  );
  const stockholm = queuesNear(snapshot, { latitude: 59.33, longitude: 18.07 });
  assert.equal(stockholm.routes, 2);
  assert.equal(stockholm.points, 0);
  assert.deepEqual(
    stockholm.items.map((item) => item.name),
    ['Sotartunneln'],
  );
  const goteborg = queuesNear(snapshot, { latitude: 57.71, longitude: 11.97 });
  assert.equal(goteborg.routes, 0);
  assert.equal(goteborg.pointsQueued, 1);
  assert.deepEqual(goteborg.items, []);
  // Where Trafikverket measures nothing, no section at all.
  assert.equal(
    queuesNear(snapshot, { latitude: 63.83, longitude: 20.26 }),
    null,
  );
  assert.equal(queuesNear(null, { latitude: 59.33, longitude: 18.07 }), null);
});
