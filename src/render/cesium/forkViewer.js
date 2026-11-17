/**
 * @module render/cesium/forkViewer
 * @description Swedish fork: its own layers and panels still drive Cesium
 * directly (`src/render/cesiumForkList.json`). The application hands every
 * layer and tool its scene object rather than Cesium's viewer, so these give
 * them the Cesium viewer behind it, until they move onto the renderer ports.
 * A test's stand-in viewer, bound to no renderer, is passed on as it is.
 */
import { viewerBehind } from './viewers.js';

export { viewerBehind };

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
