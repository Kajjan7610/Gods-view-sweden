/**
 * @module render/cesium/forkViewer
 * @description Swedish fork: the power grid layer still drives Cesium
 * directly (`src/render/cesiumForkList.json`), for its flow chevrons. The
 * application hands every layer its scene object rather than Cesium's viewer,
 * so these give it the Cesium viewer behind it, and a pick registry that
 * reads Cesium's own picks, until it moves onto the renderer ports.
 * A test's stand-in viewer, bound to no renderer, is passed on as it is.
 */
import * as pickRegistry from '../../data/pickRegistry.js';
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
