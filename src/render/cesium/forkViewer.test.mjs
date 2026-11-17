import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  cesiumPicking,
  cesiumScenePick,
  groundClassificationType,
  onCesiumViewer,
} from './forkViewer.js';
import { createSceneHost } from '../rendererOf.js';
import { recordViewer } from './viewers.js';

test("a fork layer's lifecycle gets the Cesium viewer behind the scene object", async () => {
  const cesiumViewer = { scene: {} };
  const renderer = {};
  recordViewer(renderer, cesiumViewer);
  const { host, release } = createSceneHost(renderer, { container: null });
  const seen = [];
  const layer = onCesiumViewer({
    id: 'x',
    init(viewer, options) {
      seen.push(['init', viewer, options]);
      return this.id;
    },
    async update(viewer) {
      seen.push(['update', viewer]);
      return true;
    },
  });
  assert.equal(layer.init(host, { signal: 1 }), 'x', 'its own `this`');
  assert.equal(await layer.update(host), true);
  assert.deepEqual(seen, [
    ['init', cesiumViewer, { signal: 1 }],
    ['update', cesiumViewer],
  ]);
  release();
});

test("a test's stand-in viewer, bound to no renderer, is passed on as it is", () => {
  const standIn = { scene: {} };
  let got;
  onCesiumViewer({ enable: (viewer) => (got = viewer) }).enable(standIn);
  assert.equal(got, standIn);
  onCesiumViewer({ enable: (viewer) => (got = viewer) }).enable(undefined);
  assert.equal(got, undefined);
});

test('pick ids come from the Cesium pick: an entity is named by its own id', () => {
  const entity = new Cesium.Entity({ id: 'se-hospital:1' });
  assert.equal(cesiumPicking.resolvePickId({ id: entity }), 'se-hospital:1');
  assert.equal(cesiumPicking.resolvePickId({ primitive: { id: 7 } }), '7');
  assert.equal(cesiumPicking.resolvePickId(null), null);
  assert.equal(typeof cesiumPicking.isOwnedByOtherLayer, 'function');
});

test('the ground under a click: the rendered surface, else the ellipsoid, never the sky', () => {
  const surface = Cesium.Cartesian3.fromDegrees(16.5, 59.6, 20);
  const ellipsoid = Cesium.Cartesian3.fromDegrees(16.5, 59.6, 0);
  const viewer = (depth, sphere) => ({
    scene: { pickPositionSupported: true, pickPosition: () => depth },
    camera: { pickEllipsoid: () => sphere },
  });
  const at = { x: 1, y: 1 };
  assert.equal(
    cesiumScenePick.pickGroundPosition(viewer(surface, ellipsoid), at),
    surface,
  );
  assert.equal(
    cesiumScenePick.pickGroundPosition(viewer(undefined, ellipsoid), at),
    ellipsoid,
  );
  assert.equal(
    cesiumScenePick.pickGroundPosition(viewer(undefined, undefined), at),
    null,
  );
  assert.equal(typeof cesiumScenePick.isSurfacePick, 'function');
});

test("ground lines drape on Cesium's own classification types", () => {
  assert.equal(groundClassificationType(null), Cesium.ClassificationType.BOTH);
  assert.equal(
    groundClassificationType({ globe: { show: true } }),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(
    groundClassificationType({ globe: { show: false } }),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
});
