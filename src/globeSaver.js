/**
 * Saver mode (Swedish fork): start without Google Photorealistic 3D Tiles.
 * Each start with them spends one session of the Cesium ion (or Google)
 * monthly allowance; in saver mode the globe starts on the keyless imagery
 * instead. The viewer's choice lives in this browser; `?globe=lite` forces
 * saver mode for one load (test runs use it) and `?globe=3d` forces 3D.
 */
export const GLOBE_SAVER_STORAGE_KEY = 'gev:globe-saver:v1';

/** Whether this load starts in saver mode. */
export function readGlobeSaver(storage, search = '') {
  const forced = new URLSearchParams(search).get('globe');
  if (forced === 'lite') return true;
  if (forced === '3d') return false;
  try {
    return storage?.getItem(GLOBE_SAVER_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Keep the viewer's choice; storage may be missing or refuse. */
export function saveGlobeSaver(storage, on) {
  try {
    if (on) storage?.setItem(GLOBE_SAVER_STORAGE_KEY, 'on');
    else storage?.removeItem(GLOBE_SAVER_STORAGE_KEY);
  } catch {
    /* no-op */
  }
}
