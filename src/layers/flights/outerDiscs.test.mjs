// Swedish fork: a whole view's adsb.lol discs are read at different times
// (server/providers/aircraft/adsbLolView.js). A report read longer ago than
// its centre is read again (aged) never sets how late the layer draws, and
// each aircraft leaves the map on its own once older than 30 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createClockFollow } from './clockFollow.js';

const MINUTE = 60_000;
const START = 1_800_000_000_000;

/** Any property is a no-op function unless given. */
function stub(overrides = {}) {
  return new Proxy(overrides, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function harness() {
  const iconIds = new Set();
  const cleared = [];
  const groundFloor = stub({
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    GROUND_FLOOR_LIFT_M: 0.5,
  });
  const services = stub({
    geoid: { geoidHeight: () => 0 },
    camera: stub(),
    focus: stub(),
    groundFloor,
    meshFloor: stub(),
    groundSnap: stub({ createGroundSnap: () => stub() }),
    placement: null,
  });
  const flightState = createFlightState({
    services,
    source: { label: 'Fixture aircraft' },
  });
  flightState._icons = {
    has: (id) => iconIds.has(id),
    ids: () => [...iconIds],
    get count() {
      return iconIds.size;
    },
  };
  const parts = {
    rendering: stub({ _modelOwnsVisual: () => false }),
    icons: stub({
      _addIcon: (id) => iconIds.add(id),
      _forgetContact: (id) => {
        iconIds.delete(id);
        flightState.records.forget(id);
      },
    }),
    tracking: stub({
      _militaryLayerSuppresses: () => false,
      _clearTracking: () => cleared.push(flightState._trackedIcao),
    }),
  };
  parts.motion = createMotion({ flightState, services, parts, layer: {} });
  const apply = createFlightSnapshotRenderer({
    flightState,
    records: flightState.records,
    militaryRegistry: stub({ isMilitaryIcao: () => false }),
    groundFloor,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    icons: parts.icons,
    enrichment: stub(),
    queries: stub({ _likelyLanded: () => false }),
  });
  const clockFollow = createClockFollow({ flightState, services, parts });
  return {
    flightState,
    iconIds,
    cleared,
    clockFollow,
    /** Deliver `[id, fix time, aged]` records. */
    deliver: (rows) =>
      apply(
        {
          observedAtMs: Date.now(),
          complete: true,
          records: rows.map(([id, fixMs, aged], k) => ({
            id,
            reference: id,
            longitude: 16 + k,
            latitude: 62,
            callsign: 'TEST1',
            baroAltitudeM: 9_000,
            onGround: false,
            speedMps: 220,
            courseDeg: 90,
            positionTimeMs: fixMs,
            ...(aged ? { aged: true } : {}),
          })),
        },
        null,
      ),
  };
}

test('an aged report never counts in how late the feed is, nor the first one after it', (t) => {
  let now = START;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const delay = h.flightState._displayDelay;
  h.deliver([
    ['c00001', now - 5_000],
    ['e00001', now - 20 * MINUTE, true],
  ]);
  assert.equal(delay.lagCount, 0, 'first sightings give no lag');
  // 30 s on, both move on: only the centre's report is a lag.
  now += 30_000;
  h.deliver([
    ['c00001', now - 5_000],
    ['e00001', now - 10_000, true],
  ]);
  assert.equal(delay.lagCount, 1);
  // Read afresh: its first fresh report follows an aged one, so it is a
  // first sighting too.
  now += 30_000;
  h.deliver([
    ['c00001', now - 5_000],
    ['e00001', now - 5_000],
  ]);
  assert.equal(delay.lagCount, 2, 'the centre aircraft’s lag alone');
  assert.equal(h.flightState.records.data.get('e00001').aged, false);
  now += 30_000;
  h.deliver([
    ['c00001', now - 5_000],
    ['e00001', now - 5_000],
  ]);
  assert.equal(delay.lagCount, 4, 'from then on a centre aircraft like any');
});

test('a whole view’s aircraft go once their newest fix is older than the cutoff, the tracked one too', (t) => {
  const now = START;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  h.deliver([
    ['c00001', now - 5 * MINUTE],
    ['e00001', now - 31 * MINUTE, true],
    ['e00002', now - 29 * MINUTE, true],
    ['e00003', now - 40 * MINUTE, true],
  ]);
  h.flightState._trackedIcao = 'e00003';
  const left = h.clockFollow.dropOlderThan(now - 30 * MINUTE);
  assert.deepEqual([...h.iconIds].sort(), ['c00001', 'e00002']);
  assert.equal(left, 2);
  assert.deepEqual(h.cleared, ['e00003'], 'tracking released first');
  assert.equal(h.flightState.records.data.has('e00001'), false);
});
