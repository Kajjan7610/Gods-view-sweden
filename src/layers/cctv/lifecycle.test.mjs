import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';

function viewerWithCamera() {
  const camera = fakeCameraPort();
  const viewer = {};
  bindRenderer(viewer, { camera: camera.port });
  return { viewer, camera };
}

function lifecycleFor(state) {
  const passes = [];
  const lifecycle = createLifecycle({
    state,
    services: {
      sprites: {},
      activation: {},
      picking: {},
      focus: {},
      render: {},
    },
    parts: {
      rendering: {
        refreshHorizonCulling: () => {
          passes.push('view');
          return false;
        },
      },
      geometryQueue: { enqueueViewGeometry() {} },
      cards: { refreshAmbientCards() {} },
      presentation: { notifyListeners() {} },
      navigation: { reopenNearestCamera() {} },
    },
  });
  return { lifecycle, passes };
}

test('the view listeners follow the camera port and let go on teardown', () => {
  const first = viewerWithCamera();
  const state = { _viewer: first.viewer, _enabled: false };
  const { lifecycle, passes } = lifecycleFor(state);
  const counts = (camera) => [
    camera.listenerCount('moveStart'),
    camera.listenerCount('moveEnd'),
  ];

  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);
  first.camera.emit('moveStart');
  assert.equal(state._cameraMoving, true, 'hover pauses while moving');
  first.camera.emit('moveEnd');
  assert.equal(state._cameraMoving, false);
  assert.deepEqual(passes, ['view'], 'a settled move reruns the view pass');

  // A re-init on the same viewer keeps its listeners.
  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);

  // One on a new viewer moves them to its camera.
  const second = viewerWithCamera();
  state._viewer = second.viewer;
  first.camera.emit('moveStart');
  lifecycle.attachViewListeners();
  assert.equal(state._cameraMoving, false, 'the old move is forgotten');
  assert.deepEqual(counts(first.camera), [0, 0]);
  assert.deepEqual(counts(second.camera), [1, 1]);

  lifecycle.detachViewListeners();
  assert.deepEqual(counts(second.camera), [0, 0]);
  assert.equal(state._viewListenerCamera, null);
});

// Swedish fork: the layer opens on the camera nearest the view.
const noop = () => {};
const empty = new Proxy({}, { get: () => noop });

/** A lifecycle over two cameras whose "nearest" answer the test controls. */
function harness({ nearest = 'se-vasteras' } = {}) {
  const records = [
    { camera: { id: 'austin-first', cityId: 'austin' } },
    { camera: { id: 'se-vasteras', cityId: 'sweden' } },
    { camera: { id: 'se-stockholm', cityId: 'sweden' } },
  ];
  const state = {
    _viewer: { camera: {}, scene: {} },
    _records: records,
    _recordById: new Map(records.map((r) => [r.camera.id, r])),
    _cctvOverlayHost: { setEntries: noop, setVisible: noop, clearSource: noop },
    _activeCameraId: null,
    _activeCameraAuto: false,
  };
  const view = { nearest };
  const lifecycle = createLifecycle({
    state,
    services: {
      credits: empty,
      sprites: empty,
      activation: empty,
      picking: empty,
      focus: empty,
      render: empty,
    },
    parts: {
      selection: empty,
      geometryQueue: empty,
      rendering: empty,
      projection: empty,
      cards: empty,
      presentation: empty,
      navigation: { nearestCameraIdToViewer: () => view.nearest },
    },
    source: {},
  });
  return { lifecycle, state, view };
}

test('enable starts on the camera nearest the view, not the first in the catalog', () => {
  const { lifecycle, state } = harness();
  lifecycle.methods.enable();
  assert.equal(state._activeCameraId, 'se-vasteras');
  assert.equal(state._activeCameraAuto, true);
  lifecycle.methods.disable();
  assert.equal(
    state._defaultPickTimer,
    null,
    'disable stops the follow window',
  );
});

test('an automatic pick follows the view on the next enable; a chosen camera stays', () => {
  const { lifecycle, state, view } = harness();
  lifecycle.methods.enable();
  lifecycle.methods.disable();
  view.nearest = 'se-stockholm';
  lifecycle.methods.enable();
  assert.equal(state._activeCameraId, 'se-stockholm');
  lifecycle.methods.disable();

  // The person picks a camera (selection.setActiveCamera clears the mark).
  state._activeCameraId = 'austin-first';
  state._activeCameraAuto = false;
  view.nearest = 'se-vasteras';
  lifecycle.methods.enable();
  assert.equal(state._activeCameraId, 'austin-first');
  lifecycle.methods.disable();
});

test('without a known view the catalog order still decides', () => {
  const { lifecycle, state } = harness({ nearest: null });
  lifecycle.methods.enable();
  assert.equal(state._activeCameraId, 'austin-first');
  lifecycle.methods.disable();
});
