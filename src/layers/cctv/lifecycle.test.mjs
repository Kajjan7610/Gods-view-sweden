import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifecycle } from './lifecycle.js';

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
