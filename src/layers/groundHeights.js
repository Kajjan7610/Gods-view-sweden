/**
 * Ground heights for layers with many map dots. Clamping thousands of dots
 * with `HeightReference.CLAMP_TO_GROUND` freezes the app over photorealistic
 * 3D tiles: Cesium re-picks every clamped dot inside each tile as it streams
 * in, reading tile geometry back from the GPU (seconds per frame with ~3,000
 * dots, and it goes on while the layer is hidden). A layer that gets its
 * heights here can clamp to terrain only, which is cheap, and keep its own
 * height where the globe is hidden under the 3D tiles.
 *
 * Heights come from the application's terrain service (`/api/terrain/heights`,
 * Re:Earth, disk-cached; bundled geoid math when that fails). Only the height
 * changes: a dot's latitude and longitude are never touched. A geoid
 * stand-in is about sea level, so in the mountains a tilted view would show
 * the dot off its place; those rows are asked again, backing off, until
 * Re:Earth answers.
 *
 * The terrain route allows a client 90 requests a minute, shared with the
 * camera layer and the ground floor, and a first load of every Swedish layer
 * needs about that many. So all layers here share one queue that asks for at
 * most 64 points a second, and Re:Earth heights are kept in this browser:
 * places rarely move, so a later visit asks for nothing and draws once.
 * Pure — no Cesium.
 */

/** First wait before asking again for rows that only got the geoid stand-in. */
export const GROUND_RETRY_FIRST_MS = 2 * 60_000;
/** Longest wait between such retries. */
export const GROUND_RETRY_MAX_MS = 30 * 60_000;
/** Points per request, as the terrain route takes them. */
export const GROUND_CHUNK = 64;
/** Shortest wait between two requests, across every layer. */
export const GROUND_REQUEST_GAP_MS = 1000;
/** Where the kept heights live in the browser, and how many of them. */
export const GROUND_STORE_KEY = 'gev:ground-heights:v1';
export const GROUND_STORE_MAX = 20_000;
/** The same for layers whose rows come and go with the view. */
export const GROUND_PASSING_STORE_KEY = 'gev:ground-heights:passing:v1';
export const GROUND_PASSING_STORE_MAX = 10_000;

const SAVE_DELAY_MS = 2000;

/** The rounded key the terrain route caches a point under. */
const pointKey = (lon, lat) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * Re:Earth heights this browser already has, by point. When full, the place
 * nobody has read or written for the longest goes first.
 */
function createStore(storageKey, max) {
  let kept = null;
  let saveTimer = null;
  let listening = false;

  function read(raw, into) {
    try {
      for (const [key, height] of Object.entries(raw ? JSON.parse(raw) : {}))
        if (Number.isFinite(height) && !into.has(key)) into.set(key, height);
    } catch {
      // Unreadable: heights are asked for again.
    }
    while (into.size > max) into.delete(into.keys().next().value);
  }

  function load() {
    if (kept) return kept;
    kept = new Map();
    try {
      read(globalThis.localStorage?.getItem(storageKey), kept);
    } catch {
      // Storage may be missing or refuse; heights are asked for again.
    }
    // Another tab saving its heights would otherwise be overwritten by this
    // tab's next save: take over the places this tab lacks.
    if (!listening && typeof globalThis.addEventListener === 'function') {
      listening = true;
      globalThis.addEventListener('storage', (event) => {
        if (event?.key === storageKey && event.newValue && kept)
          read(event.newValue, kept);
      });
    }
    return kept;
  }

  function save() {
    if (saveTimer !== null || !globalThis.localStorage) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        globalThis.localStorage.setItem(
          storageKey,
          JSON.stringify(Object.fromEntries(load())),
        );
      } catch {
        // Full or refused: keep them for this visit only.
      }
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }

  return {
    /** A kept height, which also counts the place as in use. */
    get(key) {
      const heights = load();
      const height = heights.get(key);
      if (height === undefined) return undefined;
      heights.delete(key);
      heights.set(key, height);
      // The order only matters once the store can fill up.
      if (heights.size * 2 > max) save();
      return height;
    },
    set(key, height) {
      const heights = load();
      heights.delete(key);
      heights.set(key, Math.round(height * 10) / 10);
      while (heights.size > max) heights.delete(heights.keys().next().value);
      save();
    },
    clear() {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      kept = null;
      try {
        globalThis.localStorage?.removeItem(storageKey);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

/**
 * Two stores: a layer whose rows come and go with the view (shelters) would
 * otherwise push out the heights of the layers whose places stay.
 */
const fixedStore = createStore(GROUND_STORE_KEY, GROUND_STORE_MAX);
const passingStore = createStore(
  GROUND_PASSING_STORE_KEY,
  GROUND_PASSING_STORE_MAX,
);

/** Forget the heights this browser kept (tests, or a reader clearing data). */
export function clearGroundHeightStore() {
  fixedStore.clear();
  passingStore.clear();
}

/** One queue for every layer, so their requests stay apart. */
let queue = Promise.resolve();
let lastRequestAt = -Infinity;

function paced(gapMs, signal, ask) {
  const run = queue.then(async () => {
    // A request cancelled while it waited gives its turn away.
    signal.throwIfAborted();
    const wait = lastRequestAt + gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    signal.throwIfAborted();
    lastRequestAt = Date.now();
    return ask();
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Keep one layer's ground heights. `place(rows)` puts the heights this
 * browser kept in place at once, so a layer that calls it before drawing
 * draws once. The rest is asked for 64 places at a time, one request at a
 * time, and `onHeights` gets the ids of the rows whose height changed after
 * each answer, to move those dots where they are. Rows of a newer view go
 * before what is left of an older one, and rows that left are forgotten.
 * Rows that only got the geoid stand-in are asked again later, backing off.
 * @param {{resolveEllipsoidalGround: Function}|null} terrain
 * @param {(ids: string[]) => void} onHeights
 * @param {object} [options] `passing` for a layer whose rows come and go
 *   with the view; timers and the request gap are injectable for tests.
 */
export function createGroundHeights(
  terrain,
  onHeights,
  {
    passing = false,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    gapMs = GROUND_REQUEST_GAP_MS,
  } = {},
) {
  const enabled = typeof terrain?.resolveEllipsoidalGround === 'function';
  const store = passing ? passingStore : fixedStore;
  /** Row id to its place, its height and when it was last asked for. */
  const entries = new Map();
  let rows = [];
  let seen = 0;
  /** The request that is out: its abort controller, places and promise. */
  let round = null;
  /** Rows asked in this attempt wait for the next one: the retry timer. */
  let attempt = 1;
  let failedAttempt = 0;
  let retryTimer = null;
  let retryMs = GROUND_RETRY_FIRST_MS;

  function stopRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  /** Take the new rows in: kept heights at once, rows that left forgotten. */
  function take(next) {
    rows = next;
    seen += 1;
    let live = 0;
    for (const row of rows) {
      const lon = row.point?.[0];
      const lat = row.point?.[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      let entry = entries.get(row.id);
      // A row that moved under its id has the old place's height: start over.
      if (!entry || entry.lon !== lon || entry.lat !== lat) {
        const key = pointKey(lon, lat);
        const height = store.get(key);
        entry = {
          lon,
          lat,
          key,
          height,
          real: height !== undefined,
          asked: 0,
          seen: 0,
        };
        entries.set(row.id, entry);
      }
      if (entry.seen !== seen) live += 1;
      entry.seen = seen;
    }
    if (entries.size > live)
      for (const [id, entry] of entries)
        if (entry.seen !== seen) entries.delete(id);
  }

  /** The next places to ask for: those of the rows shown now, a chunk's worth. */
  function nextPlaces() {
    const places = new Map();
    if (failedAttempt === attempt) return places;
    for (const row of rows) {
      const entry = entries.get(row.id);
      if (!entry || entry.real || entry.asked === attempt) continue;
      // Rows that share a place (notices around one town) share one lookup.
      let place = places.get(entry.key);
      if (!place) {
        if (places.size === GROUND_CHUNK) continue;
        place = { lat: entry.lat, lon: entry.lon, asked: [] };
        places.set(entry.key, place);
      }
      place.asked.push([row.id, entry]);
    }
    for (const place of places.values())
      for (const [, entry] of place.asked) entry.asked = attempt;
    return places;
  }

  /** A request that was dropped did not ask: its rows may go again at once. */
  function unask(places) {
    for (const place of places.values())
      for (const [, entry] of place.asked) if (!entry.real) entry.asked = 0;
  }

  /** Put one answer in place; the ids of the rows whose height changed. */
  function settle(places, results) {
    const changed = [];
    let index = 0;
    for (const [key, place] of places) {
      const result = results?.[index];
      index += 1;
      if (!Number.isFinite(result?.ellipsoid)) continue;
      const real = result.source === 'reearth';
      if (real) store.set(key, result.ellipsoid);
      for (const [id, entry] of place.asked) {
        if (entry.height !== result.ellipsoid) {
          entry.height = result.ellipsoid;
          // Not a row that left or moved while the request was out.
          if (entries.get(id) === entry) changed.push(id);
        }
        entry.real = real;
      }
    }
    return changed;
  }

  function tell(changed) {
    try {
      onHeights(changed);
    } catch (error) {
      // The layer's own drawing, not the lookup: the heights are in place.
      console.warn('[GroundHeights] redraw failed:', error);
    }
  }

  /** Ask again later while some row shown has no Re:Earth height. */
  function rest() {
    if (rows.some((row) => entries.get(row.id)?.real === false)) {
      if (retryTimer !== null) return;
      retryTimer = setTimer(() => {
        retryTimer = null;
        attempt += 1;
        // The wait grows with each try, not with each time it is set.
        retryMs = Math.min(retryMs * 2, GROUND_RETRY_MAX_MS);
        run();
      }, retryMs);
    } else {
      stopRetry();
      retryMs = GROUND_RETRY_FIRST_MS;
    }
  }

  function run() {
    if (round) return round.done;
    const controller = new AbortController();
    const { signal } = controller;
    const mine = { controller, places: null, done: null };
    round = mine;
    mine.done = (async () => {
      try {
        for (;;) {
          const places = nextPlaces();
          if (!places.size) break;
          mine.places = places;
          let results;
          try {
            results = await paced(gapMs, signal, () =>
              terrain.resolveEllipsoidalGround(
                [...places.values()].map(({ lat, lon }) => ({ lat, lon })),
                { signal },
              ),
            );
          } catch (error) {
            if (signal.aborted) return;
            // Nothing more is asked until the retry: what came before stays.
            failedAttempt = attempt;
            console.warn(
              '[GroundHeights] lookup failed:',
              error?.message || error,
            );
            break;
          }
          if (signal.aborted) return;
          mine.places = null;
          const changed = settle(places, results);
          if (changed.length) tell(changed);
          if (signal.aborted) return;
        }
      } finally {
        if (round === mine) round = null;
      }
      rest();
    })();
    return mine.done;
  }

  function drop() {
    if (round) {
      round.controller.abort();
      if (round.places) unask(round.places);
      round = null;
    }
    stopRetry();
  }

  return {
    /** Whether heights can be had at all. */
    enabled,
    /** The known height of a row, or 0 (the ellipsoid) until it arrives. */
    heightOf: (id) => entries.get(id)?.height ?? 0,
    /** Whether a row's height came from Re:Earth. */
    isReal: (id) => entries.get(id)?.real === true,
    /**
     * Take these rows as the ones shown. Kept heights are in place when this
     * returns; the promise resolves when nothing more can be asked for now.
     */
    place(next = rows) {
      if (!enabled) return Promise.resolve();
      take(next);
      return run();
    },
    /** Drop a pending lookup and retry; known heights stay. */
    cancel: drop,
    /** Forget everything. */
    clear() {
      drop();
      attempt = 1;
      failedAttempt = 0;
      retryMs = GROUND_RETRY_FIRST_MS;
      entries.clear();
      rows = [];
    },
  };
}
