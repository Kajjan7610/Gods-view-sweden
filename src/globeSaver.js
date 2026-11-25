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

/** The session mark of a reload the 3D button asked for. */
export const GLOBE_SAVER_RELOAD_KEY = 'gev:globe-saver:reload';

/**
 * Mark the reload the 3D button is about to make, so the page it reloads
 * into does not play the opening again (src/app/openingIntro.js): the
 * viewer only switched the globe, at the view they were looking at.
 */
export function markGlobeSaverReload(session = undefined) {
  try {
    // Reading sessionStorage itself can throw where site data is blocked.
    (session === undefined ? globalThis.sessionStorage : session)?.setItem(
      GLOBE_SAVER_RELOAD_KEY,
      '1',
    );
  } catch {
    /* no-op: the opening plays, as on any reload */
  }
}

/** Whether this load is the 3D button's reload; the mark is used once. */
export function takeGlobeSaverReload(session = undefined) {
  try {
    const store = session === undefined ? globalThis.sessionStorage : session;
    const marked = store?.getItem(GLOBE_SAVER_RELOAD_KEY) === '1';
    if (marked) store.removeItem(GLOBE_SAVER_RELOAD_KEY);
    return marked;
  } catch {
    return false;
  }
}
