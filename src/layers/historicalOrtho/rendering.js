/**
 * Draped-imagery renderer for the historical aerial photos layer: the photo
 * of the chosen year and variant, and for a reference year the flight-year
 * sheets and the seams over it, as XYZ imagery layers of the renderer's
 * globe port, draped on whichever surface the map stack draws. With the
 * renderer's `imageHooks`, tile requests pass a small semaphore of our own,
 * shared by every layer it owns, through each layer's admission hook;
 * without them each layer gets its share as `maxConcurrentRequests`. The
 * renderer's own request limits stay untouched. Nothing is asked for
 * outside Sweden's box or coarser than the minimum level
 * (`hiddenBelowMinLevel`).
 */
// The imagery drapes through the globe port on the renderer's ports. A
// tileset host is marked as a base the globe port drapes on
// (`markBaseTileset`).
import { markBaseTileset } from '../../render/baseTilesets.js';
import { HISTORICAL_ORTHO_MIN_LEVEL, SWEDEN_RECTANGLE } from './model.js';

const NO_HOST = Object.freeze({
  collection: null,
  kind: 'none',
  globe: null,
  imageHooks: true,
});
/** The most layers the renderer owns at once: photo, seams, sheets. */
const MAX_LAYERS = 3;

/**
 * Draw order among the globe port's imagery. The ladder: basemaps 0, fire
 * heat 0.5, weather 1–4, the Data Library's aerial photography 10
 * (`LIBRARY_AERIAL_Z`, above every other drape). The historical photos sit
 * just above the library's aerial photos, so an aerial entry of today does
 * not cover them, with the seams over the photo and the sheets with their
 * flight years over the seams. Like the library's photos they draw above
 * the heat and the weather: no value can be above 10 and below 1.
 */
export const HISTORICAL_ORTHO_Z = Object.freeze({
  photo: 10.2,
  seams: 10.3,
  meta: 10.31,
});

/** Render reason for a settled tile request. */
export const TILE_RENDER_REASON = 'historical-ortho-tiles';

/**
 * Admit a tile request while the semaphore has room. A request that finds
 * it full is deferred and asks for no frame itself: the request holding the
 * slot asks for one as it settles. One the renderer itself defers frees its
 * slot at once, and the renderer asks again on a later frame. A request
 * that loads is told to `loaded`.
 */
function admitTileRequests(admission, requestRender, loaded) {
  return (_tile, issue) => {
    if (admission.inFlight >= admission.limit) return undefined;
    admission.inFlight += 1;
    const release = () => {
      admission.inFlight -= 1;
    };
    let promise;
    try {
      promise = issue();
    } catch (error) {
      release();
      throw error;
    }
    if (!promise) {
      release();
      return undefined;
    }
    const settled = Promise.resolve(promise);
    settled.then(
      () => loaded(),
      () => {},
    );
    return settled.finally(() => {
      release();
      requestRender(TILE_RENDER_REASON);
    });
  };
}

/** A tile layer as a comparable key. */
const entryKey = (entry) => `${entry.layerId}@${entry.maxLevel}`;

/**
 * Create the renderer. The host it is bound to (`rebind`) carries the
 * viewer's globe port and whether its renderer has `imageHooks`.
 * @param {{ tileTemplate: (layerId: string) => string, credit?: string, maxTileRequests?: number, requestRender?: (reason: string) => void, onTileError?: (error: object, layerId: string) => void }} options
 */
export function createHistoricalOrthoRenderer({
  tileTemplate,
  credit = '© Lantmäteriet (CC0)',
  maxTileRequests = 6,
  requestRender = () => {},
  onTileError = () => {},
} = {}) {
  if (typeof tileTemplate !== 'function')
    throw new TypeError('Historical aerial photos need a tile template');
  let host = NO_HOST;
  let destroyed = false;
  /** Who hears a failed tile: the layer, once it is built. */
  let tileErrorListener =
    typeof onTileError === 'function' ? onTileError : () => {};
  /** Who hears a tile that loaded. */
  let tileLoadListener = () => {};
  const admission = {
    limit: Math.max(1, Math.min(6, Math.floor(maxTileRequests) || 1)),
    inFlight: 0,
  };
  const admit = admitTileRequests(admission, requestRender, () =>
    tileLoadListener(),
  );
  /** The tile layers asked for, bottom to top. */
  let wanted = [];
  /** @type {{ entry: object, layer: object, off: (() => void) | null }[]} */
  let owned = [];
  let ownedGlobe = null;
  let ownedHooks = true;
  /** Why the last draping failed, or null. */
  let failure = null;

  function specFor(entry) {
    const spec = {
      kind: 'xyz',
      url: tileTemplate(entry.layerId),
      tiling: 'webMercator',
      tileSize: 512,
      minLevel: HISTORICAL_ORTHO_MIN_LEVEL,
      hiddenBelowMinLevel: true,
      maxLevel: entry.maxLevel,
      rectangle: { ...SWEDEN_RECTANGLE },
      credit: { text: credit },
      zOrder: HISTORICAL_ORTHO_Z[entry.role] ?? HISTORICAL_ORTHO_Z.photo,
    };
    // A port without imageHooks refuses `admit`: the layers then split the
    // budget between them.
    if (host.imageHooks !== false) spec.admit = admit;
    else
      spec.maxConcurrentRequests = Math.max(
        1,
        Math.floor(admission.limit / MAX_LAYERS),
      );
    return spec;
  }

  const unmount = (record) => {
    try {
      record.off?.();
      record.layer.remove();
    } catch (error) {
      console.warn('[Data:HistoricalOrtho] layer removal failed:', error);
    }
  };

  function removeAll() {
    if (!owned.length) return false;
    for (const record of owned) unmount(record);
    owned = [];
    ownedGlobe = null;
    return true;
  }

  function mount(entry) {
    const layer = host.globe.imagery.add(specFor(entry));
    const record = { entry, layer, off: null };
    try {
      const off =
        typeof layer.on === 'function'
          ? layer.on('tileError', (error) =>
              tileErrorListener(error || {}, entry.layerId),
            )
          : null;
      record.off = typeof off === 'function' ? off : null;
    } catch (error) {
      unmount(record);
      throw error;
    }
    return record;
  }

  /**
   * Make the owned layers match what is wanted on the current host. On the
   * same globe port a layer still wanted stays (with its loaded tiles):
   * turning the flight years on adds the overlays and leaves the photo be.
   * The port orders them by `zOrder`, whenever each was added. `owned` is
   * built as the layers are added, so a port that throws midway leaves
   * nothing untracked: everything goes, and the failure is kept for the
   * row rather than thrown into the caller.
   */
  function reconcile() {
    if (destroyed || !host.globe || !wanted.length) return removeAll();
    let changed = false;
    if (ownedGlobe !== host.globe || ownedHooks !== host.imageHooks)
      changed = removeAll();
    const wantedKeys = new Set(wanted.map(entryKey));
    const kept = new Map();
    for (const record of owned) {
      if (wantedKeys.has(entryKey(record.entry)))
        kept.set(entryKey(record.entry), record);
      else {
        unmount(record);
        changed = true;
      }
    }
    const next = [];
    owned = next;
    ownedGlobe = host.globe;
    ownedHooks = host.imageHooks;
    try {
      for (const entry of wanted) {
        const record = kept.get(entryKey(entry));
        if (record) next.push(record);
        else {
          changed = true;
          next.push(mount(entry));
        }
      }
      failure = null;
    } catch (error) {
      console.warn('[Data:HistoricalOrtho] imagery refused:', error);
      failure = error;
      for (const record of kept.values())
        if (!next.includes(record)) unmount(record);
      removeAll();
      changed = true;
    }
    return changed;
  }

  return {
    /**
     * Drape these tile layers, bottom to top. The same list on the same
     * host keeps its layers (and their loaded tiles); anything else
     * replaces them.
     * @param {{layerId: string, role: string, maxLevel: number}[]} layers
     * @returns {boolean} Whether layers are now draped.
     */
    show(layers) {
      if (destroyed) return false;
      wanted = Array.isArray(layers)
        ? layers.filter((entry) => entry?.layerId).slice(0, MAX_LAYERS)
        : [];
      if (reconcile()) requestRender('historical-ortho-show');
      return owned.length > 0;
    },

    /** Take every layer off; nothing more is asked for. */
    hide() {
      wanted = [];
      failure = null;
      if (removeAll()) requestRender('historical-ortho-hide');
    },

    /**
     * Follow the map stack's host. The globe port moves the owned layers
     * between the globe and the 3D tiles itself; without a host they go,
     * and a new globe port gets them rebuilt.
     * @param {{ collection: object | null, kind: string, globe?: object | null, tileset?: object | null, imageHooks?: boolean }} nextHost
     */
    rebind(nextHost) {
      const previous = host;
      host =
        nextHost && nextHost.kind !== 'none' && nextHost.globe
          ? { ...nextHost, imageHooks: nextHost.imageHooks !== false }
          : NO_HOST;
      if (host.kind === 'tileset') markBaseTileset(host.tileset);
      const moved = host.kind !== previous.kind && owned.length > 0;
      if (reconcile() || moved) requestRender('historical-ortho-rebind');
    },

    /** The tile layer ids draped right now, bottom to top, and the host. */
    getOwned() {
      return {
        kind: host.kind,
        layerIds: owned.map((record) => record.entry.layerId),
      };
    },

    /**
     * Who hears a tile the proxy refused, with its HTTP status where the
     * renderer has one, and the tile layer's id.
     * @param {(error: {status?: number}, layerId: string) => void} listener
     */
    setTileErrorListener(listener) {
      tileErrorListener = typeof listener === 'function' ? listener : () => {};
    },

    /**
     * Who hears a tile that loaded (only through the semaphore, so with
     * `imageHooks`).
     * @param {() => void} listener
     */
    setTileLoadListener(listener) {
      tileLoadListener = typeof listener === 'function' ? listener : () => {};
    },

    /** Why the port refused the imagery, or null. */
    failure() {
      return failure;
    },

    /** Number of imagery layers this renderer owns (at most three). */
    ownedCount() {
      return owned.length;
    },

    /** Tile requests in flight now, for tests and the live gate. */
    inFlight() {
      return admission.inFlight;
    },

    /** Remove everything and refuse further work. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      wanted = [];
      const changed = removeAll();
      host = NO_HOST;
      if (changed) requestRender('historical-ortho-destroy');
    },
  };
}
