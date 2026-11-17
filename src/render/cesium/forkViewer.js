/**
 * @module render/cesium/forkViewer
 * @description Swedish fork: its own layers and panels still drive Cesium
 * directly (`src/render/cesiumForkList.json`). The application hands every
 * layer and tool its scene object rather than Cesium's viewer, so these give
 * them the Cesium viewer behind it, until they move onto the renderer ports.
 * A test's stand-in viewer, bound to no renderer, is passed on as it is.
 */
import * as Cesium from 'cesium';
import * as pickRegistry from '../../data/pickRegistry.js';
import * as scenePick from '../../data/scenePick.js';
import { nativePickId } from './nativeClick.js';
import { viewerBehind } from './viewers.js';

export { viewerBehind };

/**
 * The shared pick registry for layers that read Cesium's own picks: the
 * original's reads the renderer contract's hits, so a pick id here comes
 * from the Cesium pick (an entity's own id), as the adapter reads it.
 */
export const cesiumPicking = Object.freeze({
  ...pickRegistry,
  resolvePickId: nativePickId,
});

/**
 * The world position under a screen point on a Cesium viewer: the rendered
 * surface where the depth buffer has it, else the ellipsoid; null over the
 * sky. (The original's moved to its dispatcher, over the query port.)
 * @param {object} viewer A Cesium viewer.
 * @param {{x: number, y: number}} screenPosition
 * @returns {object|null} A Cartesian3.
 */
function pickGroundPosition(viewer, screenPosition) {
  const scene = viewer?.scene;
  let position = null;
  if (scene?.pickPositionSupported) {
    try {
      position = scene.pickPosition(screenPosition);
    } catch {
      position = null;
    }
  }
  if (!scenePick.isPickedWorldPosition(position)) {
    try {
      position = viewer?.camera?.pickEllipsoid(screenPosition) ?? null;
    } catch {
      position = null;
    }
  }
  return scenePick.isPickedWorldPosition(position) ? position : null;
}

/** The scene-pick helpers for layers that read Cesium's own picks. */
export const cesiumScenePick = Object.freeze({
  ...scenePick,
  pickGroundPosition,
});

/**
 * What the fork's ground lines drape on in `scene`, as Cesium's own
 * classification type: the 3D tiles while the globe is hidden (photoreal),
 * else the terrain, and both while the scene cannot say. (The original's
 * `cableClassificationTypeForScene` now answers its draw port in words.)
 * @param {object|null|undefined} scene A Cesium scene.
 * @returns {number} A `Cesium.ClassificationType`.
 */
export function groundClassificationType(scene) {
  if (!scene?.globe) return Cesium.ClassificationType.BOTH;
  return scene.globe.show === false
    ? Cesium.ClassificationType.CESIUM_3D_TILE
    : Cesium.ClassificationType.TERRAIN;
}

const LIFECYCLE = ['init', 'enable', 'update', 'disable', 'destroy'];

/**
 * `layer` itself, its lifecycle given the Cesium viewer behind the scene
 * object the data manager passes.
 * @template T
 * @param {T} layer
 * @returns {T}
 */
export function onCesiumViewer(layer) {
  for (const name of LIFECYCLE) {
    const method = layer[name];
    if (typeof method !== 'function') continue;
    layer[name] = function (viewer, ...rest) {
      return method.call(this, viewer && viewerBehind(viewer), ...rest);
    };
  }
  return layer;
}
