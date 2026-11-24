import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROUTE_SHAPE_ID_PATTERN } from '../../src/data/transitRouteShapes.js';
import { readShapesMember } from './trafiklabShapes.js';

/**
 * Trafiklab (Samtrafiken) GTFS Regional static data, for route numbers.
 *
 * The regional VehiclePositions feeds carry a trip id per vehicle and nothing
 * a rider would recognise. This joins each trip to its route through the
 * operator's static GTFS (`trips.txt` -> `routes.txt`) and rewrites the
 * vehicle's routeId as `<mode>:<short name>` (`bus:4`, `tram:7`), which the
 * Transit registry's Trafiklab `routeMode`/`routeLabel` hooks read back.
 *
 * The same download also keeps each stop's position and name
 * (`stops.txt`), which the Swedish fork's transit-disruption layer places
 * its alerts by, and each trip's route shape (`trips.txt` `shape_id`,
 * `shapes.txt`; trafiklabShapes.js): the vehicle gets the trip's `shapeId`,
 * and `/api/transit/shapes` serves the shape from the cache. A join cached
 * before shapes were read stays in use until it expires; the next download
 * brings them.
 *
 * Static downloads are rationed: the default Bronze key allows 50 a month,
 * so each operator's join is cached on disk for two weeks (16 operators
 * renewed weekly would need about 69 a month; every two weeks, about 35) and
 * a failed download waits six hours before the next try. Everything here runs in the
 * background; until a join is ready, vehicles pass through unchanged.
 */

export const TRAFIKLAB_STATIC_URL = (operator) =>
  `https://opendata.samtrafiken.se/gtfs/${operator}/${operator}.zip`;
export const TRAFIKLAB_STATIC_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const TRAFIKLAB_STATIC_RETRY_MS = 6 * 60 * 60_000;
export const TRAFIKLAB_STATIC_KEYLESS_RETRY_MS = 60 * 60_000;
export const TRAFIKLAB_STATIC_FETCH_TIMEOUT_MS = 5 * 60_000;
/** SL's archive is the largest, tens of MB; this bounds a runaway. */
export const TRAFIKLAB_STATIC_MAX_ZIP_BYTES = 400 * 1024 * 1024;
export const TRAFIKLAB_STATIC_MAX_FILE_BYTES = 512 * 1024 * 1024;
const CACHE_VERSION = 1;
const SHAPES_CACHE_VERSION = 1;
/**
 * Operators whose route shapes `/api/transit/shapes` keeps in memory, the
 * most recently asked: a view is over one or two counties at a time.
 */
const SHAPE_TABLES_KEPT = 4;
/** An operator with no readable shapes cache is looked for again after this. */
const SHAPES_MISS_RETRY_MS = 5 * 60_000;
const OPERATOR_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * GTFS route_type (basic and extended) -> Transit layer mode, or null.
 * @param {string|number} value
 * @returns {string|null}
 */
export function gtfsRouteMode(value) {
  // Number('') is 0, which is the tram code; a blank type is unknown.
  if (value == null || String(value).trim() === '') return null;
  const type = Number(value);
  if (!Number.isInteger(type)) return null;
  if (type === 0 || type === 5 || (type >= 900 && type <= 999)) return 'tram';
  if (type === 1 || type === 12 || (type >= 400 && type <= 499))
    return 'subway';
  if (type === 2 || (type >= 100 && type <= 199)) return 'rail';
  if (type === 4 || type === 1200 || (type >= 1000 && type <= 1099))
    return 'ferry';
  if (
    type === 3 ||
    type === 11 ||
    (type >= 200 && type <= 299) ||
    (type >= 700 && type <= 899)
  )
    return 'bus';
  return null;
}

/**
 * Read named members out of a ZIP archive. Supports stored and deflated
 * members, which is what GTFS archives use; ZIP64 archives are refused.
 * @param {Buffer} zip Whole archive.
 * @param {string[]} wanted Base names to extract (e.g. 'trips.txt').
 * @returns {Map<string, Buffer>}
 */
export function readZipMembers(zip, wanted) {
  const out = new Map();
  for (const [base, { method, data }] of readZipEntries(zip, wanted)) {
    if (method === 0) out.set(base, data);
    else if (method === 8)
      out.set(
        base,
        zlib.inflateRawSync(data, {
          maxOutputLength: TRAFIKLAB_STATIC_MAX_FILE_BYTES,
        }),
      );
    else throw new Error(`unsupported zip method ${method}`);
  }
  return out;
}

/**
 * Swedish fork: named members of a ZIP archive as stored, still compressed,
 * for a member too large to inflate at once (`shapes.txt`).
 * @param {Buffer} zip Whole archive.
 * @param {string[]} wanted Base names.
 * @returns {Map<string, {method: number, data: Buffer}>}
 */
export function readZipEntries(zip, wanted) {
  const want = new Set(wanted);
  const out = new Map();
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const entries = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff)
    throw new Error('zip64 archives are not supported');
  let at = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const base = name.split('/').pop();
    if (!want.has(base) || out.has(base)) continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('corrupt zip local header');
    const start =
      localOffset +
      30 +
      zip.readUInt16LE(localOffset + 26) +
      zip.readUInt16LE(localOffset + 28);
    out.set(base, { method, data: zip.subarray(start, start + compressed) });
  }
  return out;
}

/**
 * Call `onRow(fields, header)` for each CSV record after the header, and
 * return the header. Handles a BOM, CRLF and quoted fields with doubled
 * quotes.
 * @param {string} text
 * @param {(fields: string[], header: string[]) => void} onRow
 * @returns {string[]} Header fields.
 */
export function parseCsv(text, onRow) {
  let header = null;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const length = text.length;
  while (i < length) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (; i < length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        fields.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++;
        break;
      } else field += ch;
    }
    fields.push(field);
    if (fields.length === 1 && fields[0] === '') continue;
    if (!header) header = fields.map((f) => f.trim());
    else onRow(fields, header);
  }
  return header || [];
}

/**
 * Join trips to routes: tripId -> `<mode>:<short name>`.
 * @param {string} routesCsv routes.txt
 * @param {string} tripsCsv trips.txt
 * @param {Map<string, string>|null} [tripShapes] Swedish fork: filled with
 *   tripId -> `shape_id` for each trip that names a shape, from the same pass.
 * @returns {Map<string, string>}
 */
export function buildTripRouteIndex(routesCsv, tripsCsv, tripShapes = null) {
  const routes = new Map();
  let col = null;
  const routeHeader = parseCsv(routesCsv, (fields, header) => {
    col ??= {
      id: header.indexOf('route_id'),
      short: header.indexOf('route_short_name'),
      long: header.indexOf('route_long_name'),
      type: header.indexOf('route_type'),
    };
    const id = col.id >= 0 ? fields[col.id] : '';
    const name = String(
      (col.short >= 0 && fields[col.short]) ||
        (col.long >= 0 && fields[col.long]) ||
        id ||
        '',
    ).trim();
    const mode = gtfsRouteMode(fields[col.type]) || 'bus';
    if (id && name) routes.set(id, `${mode}:${name.slice(0, 32)}`);
  });
  if (!routeHeader.includes('route_id'))
    throw new Error('routes.txt has no route_id column');

  const trips = new Map();
  let tripCol = -1;
  let routeCol = -1;
  let shapeCol = -1;
  const tripHeader = parseCsv(tripsCsv, (fields, header) => {
    if (tripCol < 0) {
      tripCol = header.indexOf('trip_id');
      routeCol = header.indexOf('route_id');
      shapeCol = header.indexOf('shape_id');
      if (tripCol < 0 || routeCol < 0) return;
    }
    const token = routes.get(fields[routeCol]);
    if (token && fields[tripCol]) trips.set(fields[tripCol], token);
    if (tripShapes && shapeCol >= 0 && fields[tripCol] && fields[shapeCol])
      tripShapes.set(fields[tripCol], fields[shapeCol]);
  });
  if (!tripHeader.includes('trip_id') || !tripHeader.includes('route_id'))
    throw new Error('trips.txt has no trip_id/route_id columns');
  return trips;
}

/**
 * Stops by id: `[lon, lat, name, parentId]`, where parentId is the stop
 * area a platform belongs to ('' for none).
 * @param {string} stopsCsv stops.txt
 * @returns {Map<string, [number, number, string, string]>}
 */
export function buildStopIndex(stopsCsv) {
  const stops = new Map();
  let col = null;
  parseCsv(stopsCsv, (fields, header) => {
    col ??= {
      id: header.indexOf('stop_id'),
      name: header.indexOf('stop_name'),
      lat: header.indexOf('stop_lat'),
      lon: header.indexOf('stop_lon'),
      parent: header.indexOf('parent_station'),
    };
    const id = col.id >= 0 ? fields[col.id] : '';
    // An empty coordinate is missing, not zero.
    const lat = fields[col.lat] ? Number(fields[col.lat]) : NaN;
    const lon = fields[col.lon] ? Number(fields[col.lon]) : NaN;
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    stops.set(id, [
      Math.round(lon * 1e5) / 1e5,
      Math.round(lat * 1e5) / 1e5,
      String(fields[col.name] ?? '')
        .trim()
        .slice(0, 80),
      col.parent >= 0 ? String(fields[col.parent] ?? '').trim() : '',
    ]);
  });
  return stops;
}

/**
 * Swedish fork: the trips whose shape was read, as the cache keeps them:
 * each shape id once (`shapeIds`), each trip by its shape's index there.
 * @param {Map<string, string>} tripShapeIds tripId -> shape_id.
 * @param {Map<string, string>} shapes The shapes read, by id.
 * @returns {{shapeIds: string[], tripShapes: Map<string, number>}}
 */
export function joinTripShapes(tripShapeIds, shapes) {
  const shapeIds = [];
  const indexOf = new Map();
  const tripShapes = new Map();
  for (const [trip, shape] of tripShapeIds) {
    if (!shapes.has(shape)) continue;
    let index = indexOf.get(shape);
    if (index === undefined) {
      index = shapeIds.length;
      shapeIds.push(shape);
      indexOf.set(shape, index);
    }
    tripShapes.set(trip, index);
  }
  return { shapeIds, tripShapes };
}

/** The trip-to-shape join a cached file holds, or none (cached before shapes). */
function cachedShapeJoin(parsed) {
  const shapeIds = parsed?.shapeIds;
  const trips = parsed?.tripShapes;
  if (
    !Array.isArray(shapeIds) ||
    !shapeIds.every((id) => typeof id === 'string') ||
    !trips ||
    typeof trips !== 'object'
  )
    return { tripShapes: null, shapeIds: null };
  return { tripShapes: new Map(Object.entries(trips)), shapeIds };
}

/**
 * Background loader and vehicle enricher for every Trafiklab feed.
 *
 * @param {{env?: object, fetchImpl?: typeof fetch, cacheDir?: string,
 *   now?: () => number}} [options]
 * @returns {{enrichVehicles: (feed: object, vehicles: object[]) => object[],
 *   stopsFor: (operator: string) => Map<string, Array>|null,
 *   cachedShapes: (operator: string, ids: string[]) =>
 *     Promise<{staticAt: number|null, shapes: Map<string, string>}>,
 *   ready: (operator: string) => Promise<void>, close: () => void}}
 */
export function createTrafiklabStatic({
  env = process.env,
  fetchImpl = fetch,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'trafiklab'),
  now = Date.now,
} = {}) {
  /** @type {Map<string, {trips: Map<string,string>|null, loadedAt: number,
   *   tripShapes: Map<string, number>|null, shapeIds: string[]|null,
   *   retryAt: number, loading: Promise<void>|null}>} */
  const state = new Map();
  /**
   * Swedish fork: operators' route shapes as `/api/transit/shapes` serves
   * them, {fetchedAt, shapes}, the most recently asked last; the file reads
   * in flight; when an operator with no readable file is looked for again;
   * and how many downloads have renewed each operator's shapes.
   */
  const shapeTables = new Map();
  const shapeReads = new Map();
  const shapeMisses = new Map();
  const shapeRenewals = new Map();
  const controllers = new Set();
  let keylessLogged = false;
  let closed = false;
  // One download at a time: Trafiklab answers a burst of archive requests
  // with HTTP 429, and a refused download waits six hours.
  let downloads = Promise.resolve();
  const queued = (task) => {
    const run = downloads.then(task, task);
    downloads = run.catch(() => {});
    return run;
  };

  const cacheFile = (operator) =>
    path.join(cacheDir, `static-${operator}.json`);
  const stopsFile = (operator) => path.join(cacheDir, `stops-${operator}.json`);
  const shapesFile = (operator) =>
    path.join(cacheDir, `shapes-${operator}.json`);

  /** Cache an operator's shapes; false when they could not be written. */
  function writeShapes(operator, fetchedAt, shapes) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const temp = `${shapesFile(operator)}.${process.pid}.tmp`;
      fs.writeFileSync(
        temp,
        JSON.stringify({
          version: SHAPES_CACHE_VERSION,
          operator,
          fetchedAt,
          shapes: Object.fromEntries(shapes),
        }),
      );
      fs.renameSync(temp, shapesFile(operator));
      return true;
    } catch (error) {
      console.warn(
        `[trafiklab-static] could not cache ${operator} route shapes: ${error?.message || error}`,
      );
      return false;
    }
  }

  /**
   * An operator's cached shapes, or null when it has none (no file, or one
   * that is not a shapes cache). A file that cannot be read just now (busy,
   * denied) throws: it is not taken for missing.
   */
  async function readShapes(operator) {
    let text;
    try {
      text = await fs.promises.readFile(shapesFile(operator), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      if (
        parsed?.version !== SHAPES_CACHE_VERSION ||
        parsed.operator !== operator ||
        !parsed.shapes ||
        typeof parsed.shapes !== 'object'
      )
        return null;
      const shapes = new Map();
      for (const [id, encoded] of Object.entries(parsed.shapes))
        if (typeof encoded === 'string') shapes.set(id, encoded);
      return { fetchedAt: Number(parsed.fetchedAt) || 0, shapes };
    } catch (error) {
      console.warn(
        `[trafiklab-static] ${operator} route shapes cache unread: ${error?.name || 'error'}`,
      );
      return null;
    }
  }

  /** Keep an operator's shapes in memory as the most recently asked. */
  function rememberShapes(operator, table) {
    shapeTables.delete(operator);
    shapeTables.set(operator, table);
    shapeMisses.delete(operator);
    while (shapeTables.size > SHAPE_TABLES_KEPT)
      shapeTables.delete(shapeTables.keys().next().value);
  }

  /**
   * After a download: the operator's new shapes replace those in memory,
   * if any are (nobody asked otherwise: they wait in their file), and a file
   * read begun before the download is not kept.
   */
  function renewShapes(operator, table) {
    shapeRenewals.set(operator, (shapeRenewals.get(operator) ?? 0) + 1);
    shapeMisses.delete(operator);
    if (shapeTables.has(operator)) rememberShapes(operator, table);
  }

  /** An operator's shapes, from memory or its cache file; never downloaded. */
  async function shapeTable(operator) {
    const held = shapeTables.get(operator);
    if (held) {
      rememberShapes(operator, held);
      return held;
    }
    if (now() < (shapeMisses.get(operator) ?? 0)) return null;
    const renewals = shapeRenewals.get(operator) ?? 0;
    let reading = shapeReads.get(operator);
    if (!reading) {
      reading = readShapes(operator).finally(() => shapeReads.delete(operator));
      shapeReads.set(operator, reading);
    }
    const table = await reading;
    if (closed) return null;
    // A download that finished meanwhile is newer than the file read.
    if (shapeTables.has(operator)) return shapeTables.get(operator);
    if ((shapeRenewals.get(operator) ?? 0) !== renewals)
      return shapeTable(operator);
    if (!table) {
      shapeMisses.set(operator, now() + SHAPES_MISS_RETRY_MS);
      return null;
    }
    rememberShapes(operator, table);
    return table;
  }

  /**
   * The shapes of an archive's trips, read in chunks; none (straight lines)
   * when the archive has no `shapes.txt`, its trips name no shapes, or the
   * member cannot be read: the route join and stops stand either way.
   */
  async function readArchiveShapes(operator, zip, tripShapeIds) {
    try {
      const member = readZipEntries(zip, ['shapes.txt']).get('shapes.txt');
      if (!member || !tripShapeIds.size) return new Map();
      // Only an id a request could name is worth reading.
      const wanted = new Set();
      for (const id of new Set(tripShapeIds.values()))
        if (ROUTE_SHAPE_ID_PATTERN.test(id)) wanted.add(id);
      if (!wanted.size) return new Map();
      const read = await readShapesMember(member, wanted);
      if (read.dropped)
        console.warn(
          `[trafiklab-static] ${operator}: ${read.dropped} route shapes left out${read.overBudget ? `, ${read.overBudget} of them over the size cap` : ''}; straight lines for them`,
        );
      return read.shapes;
    } catch (error) {
      console.warn(
        `[trafiklab-static] ${operator} route shapes unread (${error?.message || error}); straight lines`,
      );
      return new Map();
    }
  }

  function readStops(operator) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stopsFile(operator), 'utf8'));
      if (parsed?.version !== CACHE_VERSION || parsed.operator !== operator)
        return null;
      return new Map(Object.entries(parsed.stops || {}));
    } catch {
      return null;
    }
  }

  function writeStops(operator, fetchedAt, stops) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const temp = `${stopsFile(operator)}.${process.pid}.tmp`;
      fs.writeFileSync(
        temp,
        JSON.stringify({
          version: CACHE_VERSION,
          operator,
          fetchedAt,
          stops: Object.fromEntries(stops),
        }),
      );
      fs.renameSync(temp, stopsFile(operator));
    } catch (error) {
      console.warn(
        `[trafiklab-static] could not cache ${operator} stops: ${error?.message || error}`,
      );
    }
  }

  function readCache(operator) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile(operator), 'utf8'));
      if (parsed?.version !== CACHE_VERSION || parsed.operator !== operator)
        return null;
      return {
        fetchedAt: Number(parsed.fetchedAt) || 0,
        trips: new Map(Object.entries(parsed.trips || {})),
        ...cachedShapeJoin(parsed),
      };
    } catch {
      return null;
    }
  }

  function writeCache(operator, fetchedAt, trips, shapeJoin = null) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const temp = `${cacheFile(operator)}.${process.pid}.tmp`;
      fs.writeFileSync(
        temp,
        JSON.stringify({
          version: CACHE_VERSION,
          operator,
          fetchedAt,
          trips: Object.fromEntries(trips),
          // Swedish fork: each trip's shape, by its index in shapeIds.
          ...(shapeJoin
            ? {
                shapeIds: shapeJoin.shapeIds,
                tripShapes: Object.fromEntries(shapeJoin.tripShapes),
              }
            : {}),
        }),
      );
      fs.renameSync(temp, cacheFile(operator));
    } catch (error) {
      console.warn(
        `[trafiklab-static] could not cache ${operator}: ${error?.message || error}`,
      );
    }
  }

  async function download(operator, key) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(),
      TRAFIKLAB_STATIC_FETCH_TIMEOUT_MS,
    );
    try {
      const url = new URL(TRAFIKLAB_STATIC_URL(operator));
      url.searchParams.set('key', key);
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declared) &&
        declared > TRAFIKLAB_STATIC_MAX_ZIP_BYTES
      )
        throw new Error('archive too large');
      const zip = Buffer.from(await response.arrayBuffer());
      if (zip.length > TRAFIKLAB_STATIC_MAX_ZIP_BYTES)
        throw new Error('archive too large');
      const members = readZipMembers(zip, [
        'routes.txt',
        'trips.txt',
        'stops.txt',
      ]);
      if (!members.has('routes.txt') || !members.has('trips.txt'))
        throw new Error('archive has no routes.txt/trips.txt');
      const tripShapeIds = new Map();
      const trips = buildTripRouteIndex(
        members.get('routes.txt').toString('utf8'),
        members.get('trips.txt').toString('utf8'),
        tripShapeIds,
      );
      const stops = members.has('stops.txt')
        ? buildStopIndex(members.get('stops.txt').toString('utf8'))
        : new Map();
      // Swedish fork: route shapes from the same archive (trafiklabShapes.js).
      const shapes = await readArchiveShapes(operator, zip, tripShapeIds);
      return {
        trips,
        stops,
        shapes,
        shapeJoin: joinTripShapes(tripShapeIds, shapes),
      };
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function load(operator, entry) {
    const t = now();
    const cached = readCache(operator);
    const cachedStops = readStops(operator);
    if (cachedStops) entry.stops = cachedStops;
    // The cached join's trips and their shapes (none in a join cached
    // before shapes were read: it stays in use until it expires).
    const cachedJoin = () => ({
      trips: cached.trips,
      tripShapes: cached.tripShapes,
      shapeIds: cached.shapeIds,
    });
    // A fresh join without stops is enough unless someone asked for stops.
    if (
      cached &&
      t - cached.fetchedAt < TRAFIKLAB_STATIC_MAX_AGE_MS &&
      (cachedStops || !entry.wantStops)
    ) {
      Object.assign(entry, cachedJoin(), { loadedAt: cached.fetchedAt });
      return;
    }
    const key = String(env.TRAFIKLAB_GTFS_STATIC_KEY ?? '').trim();
    if (!key) {
      if (!keylessLogged) {
        keylessLogged = true;
        console.warn(
          '[trafiklab-static] route numbers off: set TRAFIKLAB_GTFS_STATIC_KEY to join Trafiklab trips to routes',
        );
      }
      if (cached) Object.assign(entry, cachedJoin(), { loadedAt: t });
      entry.retryAt = t + TRAFIKLAB_STATIC_KEYLESS_RETRY_MS;
      return;
    }
    try {
      const { trips, stops, shapes, shapeJoin } = await queued(() =>
        download(operator, key),
      );
      // A download is paid for: it is cached even by a loader closed while it
      // was being read. The shapes first and the join last: a join names only
      // shapes that are on disk, and none when they could not be written.
      const join = writeShapes(operator, t, shapes) ? shapeJoin : null;
      writeStops(operator, t, stops);
      writeCache(operator, t, trips, join);
      if (closed) return;
      if (join) renewShapes(operator, { fetchedAt: t, shapes });
      Object.assign(entry, {
        trips,
        stops,
        tripShapes: join?.tripShapes ?? null,
        shapeIds: join?.shapeIds ?? null,
        loadedAt: t,
        retryAt: 0,
      });
      console.log(
        `[trafiklab-static] ${operator}: ${trips.size} trips joined to routes, ${stops.size} stops, ${shapes.size} route shapes`,
      );
    } catch (error) {
      // Keep any older join rather than losing route numbers to an outage;
      // the message never includes the request URL, so the key stays private.
      if (cached && !entry.trips)
        Object.assign(entry, cachedJoin(), { loadedAt: t });
      entry.retryAt = now() + TRAFIKLAB_STATIC_RETRY_MS;
      console.warn(
        `[trafiklab-static] ${operator} download failed (${error?.message || error}); next try in 6 h`,
      );
    }
  }

  function ensure(operator, { wantStops = false } = {}) {
    if (closed || !OPERATOR_RE.test(operator)) return null;
    let entry = state.get(operator);
    if (!entry) {
      entry = {
        trips: null,
        stops: null,
        tripShapes: null,
        shapeIds: null,
        wantStops: false,
        loadedAt: 0,
        retryAt: 0,
        loading: null,
      };
      state.set(operator, entry);
    }
    if (wantStops) entry.wantStops = true;
    const t = now();
    const fresh =
      entry.trips &&
      (entry.stops || !entry.wantStops) &&
      t - entry.loadedAt < TRAFIKLAB_STATIC_MAX_AGE_MS;
    if (!fresh && !entry.loading && t >= entry.retryAt) {
      entry.loading = load(operator, entry).finally(() => {
        entry.loading = null;
      });
    }
    return entry;
  }

  return {
    enrichVehicles(feed, vehicles) {
      const operator = feed?.staticOperator;
      if (!operator || !Array.isArray(vehicles)) return vehicles;
      const entry = ensure(operator);
      const trips = entry?.trips;
      if (!trips) return vehicles;
      // Swedish fork: and the trip's route shape, where the join has one.
      const { tripShapes, shapeIds } = entry;
      return vehicles.map((vehicle) => {
        const tripId = vehicle?.tripId;
        const token = tripId ? trips.get(tripId) : null;
        const index = tripId ? tripShapes?.get(tripId) : undefined;
        const shapeId = Number.isInteger(index) ? shapeIds?.[index] : null;
        if (!token && !shapeId) return vehicle;
        const enriched = { ...vehicle };
        if (token) enriched.routeId = token;
        if (shapeId) enriched.shapeId = shapeId;
        return enriched;
      });
    },
    /**
     * The operator's stops, or null until its static GTFS is on hand. The
     * first ask starts a download when no stop list is cached, which also
     * renews the route join (one download serves both).
     * @param {string} operator
     * @returns {Map<string, [number, number, string, string]>|null}
     */
    stopsFor(operator) {
      return ensure(operator, { wantStops: true })?.stops ?? null;
    },
    /**
     * Swedish fork: the operator's cached route shapes among `ids`, for
     * `/api/transit/shapes`. Read from memory or the cache file only: it
     * never starts a download, whoever asks. `staticAt` is when the shapes
     * were downloaded; null, and no shapes, when none are cached. Rejects
     * when the cache file cannot be read just now (busy, denied).
     * @param {string} operator
     * @param {string[]} ids
     * @returns {Promise<{staticAt: number|null, shapes: Map<string, string>}>}
     */
    async cachedShapes(operator, ids) {
      const none = { staticAt: null, shapes: new Map() };
      if (closed || !OPERATOR_RE.test(String(operator)) || !Array.isArray(ids))
        return none;
      const table = await shapeTable(operator);
      if (!table) return none;
      const shapes = new Map();
      for (const id of ids) {
        const encoded = table.shapes.get(id);
        if (encoded !== undefined) shapes.set(id, encoded);
      }
      return { staticAt: table.fetchedAt, shapes };
    },
    /** Resolves when the operator's current load attempt settles. Tests. */
    async ready(operator) {
      await ensure(operator)?.loading;
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      state.clear();
      shapeTables.clear();
      shapeReads.clear();
      shapeMisses.clear();
      shapeRenewals.clear();
    },
  };
}

let shared = null;
/** One loader per server process, shared by the transit and alert routes. */
export function sharedTrafiklabStatic() {
  shared ??= createTrafiklabStatic();
  return shared;
}
