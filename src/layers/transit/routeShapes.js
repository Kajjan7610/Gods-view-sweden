import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { createRailPath } from '../../data/railPaths.js';
import { readFix } from '../../data/contactPlayback.js';
import {
  ROUTE_SHAPES_MAX_IDS,
  ROUTE_SHAPE_ID_PATTERN,
  ROUTE_SHAPE_MIN_TRAVEL_M,
  decodeRouteShape,
  initRouteShapeFrame,
  routeShapeBetween,
} from '../../data/transitRouteShapes.js';
import { displacementPlausible, fixDistanceM } from './movement.js';

/**
 * Swedish fork: the Trafiklab feeds' buses, trams, metro and commuter trains
 * and boats follow their trip's route shape between two position reports,
 * where every rule of `routeShapeBetween` holds
 * (../../data/transitRouteShapes.js); otherwise, and for every other feed,
 * trails.js's straight steps stand.
 *
 * A feed whose registry entry names a `staticOperator` (the 16 Trafiklab
 * operators) has shapes: the server gives each vehicle its trip's `shapeId`
 * (server/providers/trafiklabStatic.js), and `/api/transit/shapes` serves the
 * shape from its cache only. A shape is asked for only while the layer is
 * on, for a vehicle drawn (or selected, or ridden) between two reports that
 * are apart, and with the camera below LOAD_MAX_ALTITUDE_M, where a corner
 * cut is visible; asks are batched per feed, ROUTE_SHAPES_MAX_IDS at most and
 * no more than the cache has room for, one request per feed at a time.
 * Shapes are kept in a least-recently-used cache of MAX_SHAPES shapes and
 * MAX_POINTS points (each point is 40 bytes of typed arrays: 12 MB at most);
 * a shape used in the last KEEP_IN_USE_MS is never evicted for another.
 * Turning the layer off aborts what is in flight and drops every shape.
 *
 * A segment between two reports is decided once its reports and shape are
 * known. One the vehicle has been drawn along keeps its decision, so a shape
 * that arrives late never moves a drawn vehicle sideways, nor redraws the
 * selected vehicle's trail where it went straight; the segments after it
 * follow the shape. Where the earlier report lay along the shape carries
 * over a standing vehicle's segments, and from one preparation to the next.
 */

/** The shapes route (server/providers/trafiklabShapes.js). */
export const ROUTE_SHAPES_URL = '/api/transit/shapes';
/** Shapes kept, and their points (40 bytes each). */
const MAX_SHAPES = 384;
const MAX_POINTS = 300_000;
/** Above this camera height a cut corner is under a pixel: nothing is asked (m). */
const LOAD_MAX_ALTITUDE_M = 15_000;
/** A shapes answer larger than this is refused (the server caps it at 1 MiB). */
const RESPONSE_MAX_BYTES = 1536 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
/** A feed whose shapes request failed is asked again after this. */
const RETRY_MS = 60_000;
/** A shape the server does not hold is asked for again after this. */
const MISSING_MS = 10 * 60_000;
const MISSING_MAX = 4096;
/** Ids waiting for a request, per feed. */
const QUEUE_MAX = 256;
/** A shape used this recently is never evicted for another (ms). */
const KEEP_IN_USE_MS = 30_000;
/** Trips a vehicle remembers the shapes of: its current one and a few before. */
const TRIPS_PER_VEHICLE = 4;

/**
 * Route shapes for one Transit layer instance.
 * @param {{state: object, parts: object, services: object,
 *   prepare: (entry: object) => void, fetchImpl?: typeof fetch,
 *   maxShapes?: number, maxPoints?: number}} context
 *   `prepare` re-prepares a vehicle's paths once its shape has arrived.
 * @returns {object}
 */
export function createRouteShapes({
  state,
  parts,
  services,
  prepare,
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxShapes = MAX_SHAPES,
  maxPoints = MAX_POINTS,
}) {
  /** `${feedId}\n${shapeId}` -> {path, uid, points, usedAt}, oldest first. */
  const cache = new Map();
  let points = 0;
  let uids = 0;
  /** feedId -> when its static GTFS was downloaded, as the server says. */
  const versions = new Map();
  /** feedId -> shape ids to ask for. */
  const queued = new Map();
  /** Keys in a request now, and the feeds with one in flight. */
  const pending = new Set();
  const busy = new Set();
  /** key -> when it may be asked for again. */
  const missing = new Map();
  /** feedId -> when it may be asked again after a failure. */
  const retryAt = new Map();
  /** key -> the vehicles whose paths wait for it. */
  const waiting = new Map();
  /** In-flight requests: {controller, timer}. */
  const flights = new Set();
  let flushScheduled = false;
  let generation = 0;
  let requests = 0;

  const keyOf = (feedId, shapeId) => `${feedId}\n${shapeId}`;

  /** Whether a vehicle's feed has shapes (the Trafiklab feeds). */
  function eligible(entry) {
    entry.routeShapeFeed ??=
      typeof getRegisteredTransitFeed(entry.feedId)?.staticOperator ===
      'string';
    return entry.routeShapeFeed;
  }

  /** Remember the newest report's trip and the shape the server gave it. */
  function noteTrip(entry) {
    const trip = entry.record?.tripId;
    const shapeId = entry.record?.shapeId;
    if (
      typeof trip !== 'string' ||
      !trip ||
      typeof shapeId !== 'string' ||
      !ROUTE_SHAPE_ID_PATTERN.test(shapeId)
    )
      return;
    let trips = entry.routeShapeTrips;
    if (!trips) entry.routeShapeTrips = trips = new Map();
    if (trips.get(trip) === shapeId) return;
    trips.delete(trip);
    trips.set(trip, shapeId);
    while (trips.size > TRIPS_PER_VEHICLE)
      trips.delete(trips.keys().next().value);
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // After the pass that asked: one batch for all its vehicles.
    queueMicrotask(flush);
  }

  /** The vehicles waiting for `key` let go: it will be asked for again. */
  function release(key) {
    waiting.delete(key);
  }

  /**
   * A cached shape (most recently used last), or null; a missing one is
   * queued when `want` and the layer is on.
   */
  function lookup(entry, shapeId, want) {
    const key = keyOf(entry.feedId, shapeId);
    const held = cache.get(key);
    if (held) {
      cache.delete(key);
      cache.set(key, held);
      held.usedAt = Date.now();
      return held;
    }
    if (!want || state._enabled !== true) return null;
    const until = missing.get(key);
    if (until !== undefined) {
      if (until > Date.now()) return null;
      missing.delete(key);
    }
    // Waited for only once it is asked for, or queued to be: a vehicle past
    // a full queue is not held on to.
    if (!pending.has(key)) {
      let ids = queued.get(entry.feedId);
      if (!ids) queued.set(entry.feedId, (ids = new Set()));
      if (!ids.has(shapeId)) {
        if (ids.size >= QUEUE_MAX) return null;
        ids.add(shapeId);
      }
      scheduleFlush();
    }
    let waiters = waiting.get(key);
    if (!waiters) waiting.set(key, (waiters = new Set()));
    waiters.add(entry);
    return null;
  }

  /**
   * How many more shapes may be asked for: free places, and the least
   * recently used ones not used in the last KEEP_IN_USE_MS, less those
   * already on their way.
   */
  function room(now) {
    let free = maxShapes - cache.size;
    for (const held of cache.values()) {
      if (now - held.usedAt <= KEEP_IN_USE_MS) break;
      free += 1;
    }
    return free - pending.size;
  }

  function flush() {
    flushScheduled = false;
    if (state._enabled !== true || !queued.size) {
      for (const [feedId, ids] of queued)
        for (const id of ids) release(keyOf(feedId, id));
      queued.clear();
      return;
    }
    const now = Date.now();
    const low = parts.rendering?.cameraHeightM?.() <= LOAD_MAX_ALTITUDE_M;
    let free = room(now);
    for (const [feedId, ids] of queued) {
      if (busy.has(feedId)) continue;
      const batch = [];
      for (const id of ids) {
        ids.delete(id);
        const key = keyOf(feedId, id);
        if (cache.has(key) || pending.has(key)) continue;
        if (!low || (retryAt.get(feedId) ?? 0) > now || free <= 0) {
          release(key);
          continue;
        }
        batch.push(id);
        free -= 1;
        if (batch.length >= ROUTE_SHAPES_MAX_IDS) break;
      }
      if (!ids.size) queued.delete(feedId);
      if (batch.length) request(feedId, batch);
    }
  }

  /** Read a shapes answer, refusing one past RESPONSE_MAX_BYTES. */
  async function readAnswer(response, signal) {
    if (!response?.ok) {
      try {
        await response?.body?.cancel?.();
      } catch {
        /* no-op */
      }
      throw new Error(`HTTP ${response?.status}`);
    }
    const reader = response.body?.getReader?.();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > RESPONSE_MAX_BYTES)
            throw new RangeError('Route shapes exceed the response limit');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
    } else {
      text = await response.text();
      if (text.length > RESPONSE_MAX_BYTES)
        throw new RangeError('Route shapes exceed the response limit');
    }
    signal.throwIfAborted();
    return JSON.parse(text);
  }

  /**
   * Keep a shape, evicting the least recently used ones it needs room from,
   * never one used in the last KEEP_IN_USE_MS.
   * @returns {boolean} False when every shape left is in use: it is not kept.
   */
  function keep(key, path, now) {
    while (
      cache.size > 0 &&
      (cache.size >= maxShapes || points + path.n > maxPoints)
    ) {
      const [oldestKey, oldest] = cache.entries().next().value;
      if (now - oldest.usedAt <= KEEP_IN_USE_MS) return false;
      cache.delete(oldestKey);
      points -= oldest.points;
    }
    cache.set(key, { path, uid: ++uids, points: path.n, usedAt: now });
    points += path.n;
    return true;
  }

  /** Forget a feed's shapes: its static GTFS has been renewed. */
  function forgetFeed(feedId) {
    const prefix = `${feedId}\n`;
    for (const [key, held] of cache)
      if (key.startsWith(prefix)) {
        cache.delete(key);
        points -= held.points;
      }
    for (const key of missing.keys())
      if (key.startsWith(prefix)) missing.delete(key);
  }

  function accept(feedId, ids, body) {
    if (
      !body ||
      typeof body !== 'object' ||
      body.version !== 1 ||
      body.feedId !== feedId ||
      !body.shapes ||
      typeof body.shapes !== 'object'
    )
      throw new TypeError('Malformed route shapes');
    const staticAt = Number.isFinite(body.staticAt) ? body.staticAt : null;
    if (versions.has(feedId) && versions.get(feedId) !== staticAt)
      forgetFeed(feedId);
    versions.set(feedId, staticAt);
    const deferred = new Set(Array.isArray(body.deferred) ? body.deferred : []);
    const arrived = new Set();
    const now = Date.now();
    for (const id of ids) {
      const key = keyOf(feedId, id);
      const text = Object.hasOwn(body.shapes, id) ? body.shapes[id] : null;
      const coords = decodeRouteShape(text);
      const path = coords ? createRailPath(coords) : null;
      if (path) {
        // No room left beside the shapes in use: asked for again later.
        if (keep(key, path, now))
          for (const entry of waiting.get(key) || []) arrived.add(entry);
      } else if (!deferred.has(id)) {
        if (missing.size >= MISSING_MAX)
          missing.delete(missing.keys().next().value);
        missing.set(key, now + MISSING_MS);
      }
      release(key);
    }
    // Their segments that the vehicle is not on yet follow the shape now.
    let prepared = 0;
    for (const entry of arrived)
      if (state._enabled === true && state._vehicles.get(entry.key) === entry) {
        prepare(entry);
        prepared += 1;
      }
    if (prepared) services.render.governorRequestRender('transit-route-shapes');
  }

  function request(feedId, ids) {
    const controller = new AbortController();
    const flight = {
      controller,
      timer: setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS),
    };
    flights.add(flight);
    busy.add(feedId);
    for (const id of ids) pending.add(keyOf(feedId, id));
    requests += 1;
    const asked = generation;
    const url = `${ROUTE_SHAPES_URL}?feed=${encodeURIComponent(feedId)}&ids=${ids.map(encodeURIComponent).join(',')}`;
    Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        }),
      )
      .then((response) => readAnswer(response, controller.signal))
      .then((body) => {
        if (asked === generation) accept(feedId, ids, body);
      })
      .catch(() => {
        if (asked !== generation) return;
        // Straight lines meanwhile; asked again once the wait is over.
        retryAt.set(feedId, Date.now() + RETRY_MS);
        for (const id of ids) release(keyOf(feedId, id));
      })
      .finally(() => {
        clearTimeout(flight.timer);
        flights.delete(flight);
        if (asked !== generation) return;
        busy.delete(feedId);
        for (const id of ids) pending.delete(keyOf(feedId, id));
        if (queued.size) scheduleFlush();
      });
  }

  /**
   * Start a vehicle's path preparation: its shapes and trips are looked at,
   * and the segments it decides are kept for the next one. Null for a
   * vehicle whose feed has no shapes.
   * @param {object} entry
   * @returns {object|null} The pass, for `segment` and `end`.
   */
  function begin(entry) {
    if (!eligible(entry)) return null;
    noteTrip(entry);
    initRouteShapeFrame(entry);
    return {
      entry,
      records: new Map(),
      // Shapes are asked for only for a vehicle in play, while the layer is
      // on and the camera low enough for a cut corner to show.
      want:
        state._enabled === true &&
        (state._visible.has(entry) ||
          entry.key === state._selectedKey ||
          entry.key === state._cockpitSubjectKey) &&
        parts.rendering?.cameraHeightM?.() <= LOAD_MAX_ALTITUDE_M,
      displayT: entry.sample?.displayT ?? NaN,
      shaped: 0,
      // Where the newest report this pass reached lay along its shape:
      // {t, s, uid}, or null.
      chain: null,
    };
  }

  /** Whether `record` was decided for these two reports. */
  const decidedFor = (record, a, b) =>
    record !== undefined &&
    record.toT === b.t &&
    record.aLat === a.lat &&
    record.aLon === a.lon &&
    record.bLat === b.lat &&
    record.bLon === b.lon;

  /**
   * The shaped points between reports `a` and `b` (same epoch, in order), or
   * null for straight steps. `maxSteps` is the room the path may take.
   */
  function segment(pass, a, b, maxSteps) {
    if (!pass) return null;
    const entry = pass.entry;
    const context = entry.track.epochs.get(a.epoch);
    const shapeId = context?.trip
      ? entry.routeShapeTrips?.get(context.trip)
      : undefined;
    const straightM = fixDistanceM(a, b);
    const moving = straightM >= ROUTE_SHAPE_MIN_TRAVEL_M;
    const shape = shapeId ? lookup(entry, shapeId, pass.want && moving) : null;
    const old = entry.routeShapeSegments?.get(a.t);
    // The segment the vehicle is drawn along, and one it was drawn along,
    // keep their decision.
    const drawing = pass.displayT > a.t && pass.displayT < b.t;
    // Where the earlier report lay along the shape: as this pass's segment
    // before ended, else as the last pass's newest did.
    const chain =
      pass.chain?.t === a.t
        ? pass.chain
        : entry.routeShapeChain?.t === a.t
          ? entry.routeShapeChain
          : null;
    let record;
    if (decidedFor(old, a, b) && (old.final || drawing || old.drawn))
      record = old;
    else {
      record = {
        toT: b.t,
        aLat: a.lat,
        aLon: a.lon,
        bLat: b.lat,
        bLon: b.lon,
        geom: null,
        // Not final until its shape is known: a shape may still come.
        final: shape !== null,
      };
      if (shape) {
        const mode = context?.mode || entry.mode;
        const inferred = entry.modeInferred === true;
        record.geom = routeShapeBetween(shape.path, a, b, {
          maxSteps,
          uid: shape.uid,
          hintS: chain?.uid === shape.uid ? chain.s : NaN,
          plausible: (metres, seconds) =>
            displacementPlausible(mode, metres, seconds, inferred),
        });
      }
    }
    if (drawing) record.drawn = true;
    pass.records.set(a.t, record);
    const geom =
      record.geom && record.geom.lat.length - 1 <= maxSteps
        ? record.geom
        : null;
    if (geom) pass.shaped += 1;
    // The chain runs forward only: the selected vehicle's older segments,
    // walked back after, leave it where the newest one put it.
    if (!pass.chain || b.t > pass.chain.t) {
      if (geom) pass.chain = { t: b.t, s: geom.sB, uid: geom.uid };
      // A vehicle standing still, or creeping, is still where it was.
      else if (
        chain &&
        straightM < (entry.track.policy?.courseMinTravelM ?? 12)
      )
        pass.chain = { t: b.t, s: chain.s, uid: chain.uid };
    }
    return geom;
  }

  /** Scratch for `end`'s read of the oldest report. */
  const oldest = {};

  /** Finish a pass: its decisions are the vehicle's now. */
  function end(entry, pass) {
    if (!pass) return;
    // A segment the vehicle was drawn along in a straight line stays so
    // once passed, while its reports are kept: the selected vehicle's trail
    // shows the way it was drawn, not a shape that came later.
    const previous = entry.routeShapeSegments;
    if (previous && entry.track.count) {
      const since = readFix(entry.track, 0, oldest).t;
      for (const [t, record] of previous)
        if (
          record.drawn === true &&
          record.geom === null &&
          t >= since &&
          !pass.records.has(t)
        )
          pass.records.set(t, record);
    }
    entry.routeShapeSegments = pass.records;
    entry.routeShapeChain = pass.chain;
    // A vehicle standing where it arrived along its shape is still drawn
    // along it (followRouteShape) until it moves on in a straight line.
    entry.routeShaped = pass.shaped > 0 || entry.routeShapeDrawn === true;
    // The frame looks its segment's path up again: the paths may change now.
    entry.routeShapeAt = -1;
  }

  /**
   * Floor the selected vehicle's shaped corridor first, through `floor`, so
   * its surface is read where it will be drawn.
   */
  function corridor(entry, a, b, floor) {
    const record = entry.routeShapeSegments?.get(a.t);
    if (!decidedFor(record, a, b) || !record.geom) return;
    const { lat, lon } = record.geom;
    for (let i = 0; i < lat.length; i++) floor({ lat: lat[i], lon: lon[i] });
  }

  /** Drop every shape and request: the layer is off. */
  function clear() {
    generation += 1;
    for (const flight of flights) {
      clearTimeout(flight.timer);
      flight.controller.abort();
    }
    flights.clear();
    busy.clear();
    pending.clear();
    queued.clear();
    waiting.clear();
    missing.clear();
    retryAt.clear();
    versions.clear();
    cache.clear();
    points = 0;
  }

  return {
    begin,
    segment,
    end,
    corridor,
    clear,
    diagnostics: () => ({
      shapes: cache.size,
      points,
      requests,
      pending: pending.size,
      inFlight: flights.size,
      waiting: waiting.size,
    }),
  };
}
