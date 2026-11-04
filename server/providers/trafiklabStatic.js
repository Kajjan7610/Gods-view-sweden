import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

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
 * its alerts by.
 *
 * Static downloads are rationed: the default Bronze key allows 50 a month,
 * so each operator's join is cached on disk for a week and a failed download
 * waits six hours before the next try. Everything here runs in the
 * background; until a join is ready, vehicles pass through unchanged.
 */

export const TRAFIKLAB_STATIC_URL = (operator) =>
  `https://opendata.samtrafiken.se/gtfs/${operator}/${operator}.zip`;
export const TRAFIKLAB_STATIC_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const TRAFIKLAB_STATIC_RETRY_MS = 6 * 60 * 60_000;
export const TRAFIKLAB_STATIC_KEYLESS_RETRY_MS = 60 * 60_000;
export const TRAFIKLAB_STATIC_FETCH_TIMEOUT_MS = 5 * 60_000;
/** SL's archive is the largest, tens of MB; this bounds a runaway. */
export const TRAFIKLAB_STATIC_MAX_ZIP_BYTES = 400 * 1024 * 1024;
export const TRAFIKLAB_STATIC_MAX_FILE_BYTES = 512 * 1024 * 1024;
const CACHE_VERSION = 1;
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
    const data = zip.subarray(start, start + compressed);
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
 * @returns {Map<string, string>}
 */
export function buildTripRouteIndex(routesCsv, tripsCsv) {
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
  const tripHeader = parseCsv(tripsCsv, (fields, header) => {
    if (tripCol < 0) {
      tripCol = header.indexOf('trip_id');
      routeCol = header.indexOf('route_id');
      if (tripCol < 0 || routeCol < 0) return;
    }
    const token = routes.get(fields[routeCol]);
    if (token && fields[tripCol]) trips.set(fields[tripCol], token);
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
 * Background loader and vehicle enricher for every Trafiklab feed.
 *
 * @param {{env?: object, fetchImpl?: typeof fetch, cacheDir?: string,
 *   now?: () => number}} [options]
 * @returns {{enrichVehicles: (feed: object, vehicles: object[]) => object[],
 *   ready: (operator: string) => Promise<void>, close: () => void}}
 */
export function createTrafiklabStatic({
  env = process.env,
  fetchImpl = fetch,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'trafiklab'),
  now = Date.now,
} = {}) {
  /** @type {Map<string, {trips: Map<string,string>|null, loadedAt: number,
   *   retryAt: number, loading: Promise<void>|null}>} */
  const state = new Map();
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
      };
    } catch {
      return null;
    }
  }

  function writeCache(operator, fetchedAt, trips) {
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
      return {
        trips: buildTripRouteIndex(
          members.get('routes.txt').toString('utf8'),
          members.get('trips.txt').toString('utf8'),
        ),
        stops: members.has('stops.txt')
          ? buildStopIndex(members.get('stops.txt').toString('utf8'))
          : new Map(),
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
    // A fresh join without stops is enough unless someone asked for stops.
    if (
      cached &&
      t - cached.fetchedAt < TRAFIKLAB_STATIC_MAX_AGE_MS &&
      (cachedStops || !entry.wantStops)
    ) {
      Object.assign(entry, { trips: cached.trips, loadedAt: cached.fetchedAt });
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
      if (cached) Object.assign(entry, { trips: cached.trips, loadedAt: t });
      entry.retryAt = t + TRAFIKLAB_STATIC_KEYLESS_RETRY_MS;
      return;
    }
    try {
      const { trips, stops } = await queued(() => download(operator, key));
      if (closed) return;
      writeCache(operator, t, trips);
      writeStops(operator, t, stops);
      Object.assign(entry, { trips, stops, loadedAt: t, retryAt: 0 });
      console.log(
        `[trafiklab-static] ${operator}: ${trips.size} trips joined to routes, ${stops.size} stops`,
      );
    } catch (error) {
      // Keep any older join rather than losing route numbers to an outage;
      // the message never includes the request URL, so the key stays private.
      if (cached && !entry.trips)
        Object.assign(entry, { trips: cached.trips, loadedAt: t });
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
      const trips = ensure(operator)?.trips;
      if (!trips) return vehicles;
      return vehicles.map((vehicle) => {
        const token = vehicle?.tripId ? trips.get(vehicle.tripId) : null;
        return token ? { ...vehicle, routeId: token } : vehicle;
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
    /** Resolves when the operator's current load attempt settles. Tests. */
    async ready(operator) {
      await ensure(operator)?.loading;
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      state.clear();
    },
  };
}

let shared = null;
/** One loader per server process, shared by the transit and alert routes. */
export function sharedTrafiklabStatic() {
  shared ??= createTrafiklabStatic();
  return shared;
}
