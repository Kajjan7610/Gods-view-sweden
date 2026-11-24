// Swedish fork: the standalone controls hand the Cockpit its rides on the
// catalog's Transit and Rail layers (cockpitRides.js), after the subjects a
// caller gives, with the caller's other services kept, and the page's world
// focus to frame a Transit vehicle when its ride is left.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import '../testSupport/stubMgrs.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';

const { createStandaloneControls } = await import('./controls.js');

let uninstallDom;
before(() => {
  uninstallDom = installVueDom();
});
after(() => uninstallDom());

/** A layer whose selected vehicle is `key`, as the rides read it. */
const layerWith = (key) => ({
  getSelectedVehicle: () => ({ key, position: {}, motion: {} }),
  getSelectedTrain: () => ({ key, position: {}, motion: {} }),
});

/** The services the controls hand their Controls, built with `options`. */
function servicesOf(options = {}) {
  let services = null;
  class Controls {
    constructor(viewer, settings) {
      services = settings.services;
    }
    hasShareState = false;
    orbitController = { stop() {} };
    hud = { destroy() {} };
    dispose() {}
  }
  const layers = {
    transit: layerWith('transit:bus-1'),
    rail: layerWith('rail:train-1'),
  };
  const cleanups = [];
  createStandaloneControls({
    scene: {
      viewer: bindFakeCesiumCamera({
        isDestroyed: () => false,
        camera: { setView() {} },
      }),
      mapStackController: {},
      operations: {
        surface: { controlServices: {} },
        searchAndFlyTo() {},
        requests: { regional: {}, weather: {} },
      },
    },
    loaderStatus: {},
    Controls,
    catalog: { get: (id) => layers[id] ?? { id } },
    defer: (cleanup) => cleanups.push(cleanup),
    ...options,
  });
  for (const cleanup of cleanups.reverse()) cleanup();
  return services;
}

test('the Cockpit gets rides on the catalog’s own Transit and Rail layers', () => {
  const { cockpitSubjects } = servicesOf();
  assert.deepEqual(
    cockpitSubjects.map(({ kind, layerId }) => [kind, layerId]),
    [
      ['transit-ride', 'transit'],
      ['rail-ride', 'rail'],
    ],
  );
  assert.deepEqual(
    cockpitSubjects.map((ride) => ride.candidate()?.id),
    ['transit:bus-1', 'rail:train-1'],
  );
});

test('a caller’s own subjects come first and its other services are kept', () => {
  const own = { kind: 'host-ride' };
  const given = { cockpitSubjects: [own], hostService: 'kept' };
  const services = servicesOf({ services: given });
  assert.deepEqual(
    services.cockpitSubjects.map(({ kind }) => kind),
    ['host-ride', 'transit-ride', 'rail-ride'],
  );
  assert.equal(services.cockpitSubjects[0], own);
  assert.equal(services.hostService, 'kept');
  assert.deepEqual(given.cockpitSubjects, [own], 'the caller’s list as given');
  assert.deepEqual(
    servicesOf({
      services: { cockpitSubjects: 'not a list' },
    }).cockpitSubjects.map(({ kind }) => kind),
    ['transit-ride', 'rail-ride'],
  );
});

test('leaving a Transit ride asks the page to frame the vehicle from above', () => {
  const vehicle = {
    key: 'transit:bus-1',
    position: { latitude: 59.33, longitude: 18.06, groundHeightM: 20 },
    motion: {},
  };
  let held = null;
  const transit = {
    getSelectedVehicle: () => vehicle,
    getCockpitSubject: () => held,
    setCockpitSubject(key) {
      held = key ? vehicle : null;
      return true;
    },
    focusVehicle: () => true,
  };
  const ride = servicesOf({
    catalog: { get: (id) => (id === 'transit' ? transit : { id }) },
  }).cockpitSubjects.find(({ kind }) => kind === 'transit-ride');
  const requests = [];
  const listen = (event) => requests.push(event.detail);
  window.addEventListener(WORLD_FOCUS_REQUEST_EVENT, listen);
  try {
    assert.equal(ride.hold(vehicle.key), true);
    ride.release(vehicle.key, { restore: true });
  } finally {
    window.removeEventListener(WORLD_FOCUS_REQUEST_EVENT, listen);
  }
  assert.deepEqual(
    requests.map(({ kind, id }) => [kind, id]),
    [['train', 'transit:bus-1']],
  );
});
