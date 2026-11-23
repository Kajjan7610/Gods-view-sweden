import { findCamera } from '../../render/rendererOf.js';
import { viewAnchor, viewExtent } from '../../render/camera/viewAnchor.js';

export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  /**
   * The feed query, or {} with no place yet. Swedish fork: the flights are
   * read around the look-at point, the map's centre, where the user looks,
   * with the ground in view around it (`bbox`) when the camera knows it, so
   * a wider view is covered too; in Cockpit around the camera's ground
   * point, the aircraft flown, whose line of sight runs to the horizon.
   */
  function _flightQuery(viewer) {
    if (!viewer) return {};
    if (!flightState._cockpitContactMode) {
      const anchor = viewAnchor(viewer);
      if (!anchor) return {};
      const bbox = viewExtent(viewer);
      return bbox ? { ...anchor, bbox } : anchor;
    }
    const pose = findCamera(viewer)?.pose();
    // An eye at the earth's centre has no ground point: the pose gives NaN.
    return pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon)
      ? { latitude: pose.lat, longitude: pose.lon }
      : {};
  }
  return { _abortActiveUpdates, _flightQuery };
}
