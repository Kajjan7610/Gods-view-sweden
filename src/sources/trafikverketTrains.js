/**
 * Trafikverket (Sweden) live train positions for the Transit layer.
 *
 * Trafikverket publishes train GPS positions as the `TrainPosition` object of
 * its open traffic API (CC0 1.0) rather than as GTFS-Realtime, so this module
 * stands in for the protobuf decoder: it POSTs one XML query and flattens the
 * JSON answer into the same vehicle records `decodeVehiclePositions` returns.
 *
 * The API needs a free key (TRAFIKVERKET_API_KEY). The key is read by the
 * server-side transit and rail services and only ever travels in the request
 * body to Trafikverket; it is never logged and never reaches the browser.
 *
 * The Transit layer shows every train and the Rail layer the same trains by
 * service category, so both read one shared snapshot (sharedTrainSnapshot):
 * Trafikverket is asked at most once per TRAFIKVERKET_TRAINS_SHARE_MS
 * however many layers are watching.
 */

import { readResponseBytesCapped } from './httpBody.js';
import {
  TRANSIT_PROXY_TIMEOUT_MS,
  TRANSIT_PROXY_TTL_MS,
  repairVehicleTimestamps,
} from '../data/transitProxy.js';

export const TRAFIKVERKET_TRAINS_KIND = 'trafikverket-trainposition';
export const TRAFIKVERKET_API_URL =
  'https://api.trafikinfo.trafikverket.se/v2/data.json';
/** Positions older than this are not asked for: a train that has not
 * reported for ten minutes has stopped running or lost its transmitter. */
export const TRAFIKVERKET_TRAINS_MAX_AGE_MS = 10 * 60_000;
/** The whole country is a few hundred trains; this only bounds a runaway. */
export const TRAFIKVERKET_TRAINS_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const TRAFIKVERKET_TRAINS_MAX_RECORDS = 5000;

const TRAIN_FIELDS = [
  'Train.AdvertisedTrainNumber',
  'Train.OperationalTrainNumber',
  'Train.OperationalTrainDepartureDate',
  'Position.WGS84',
  'Bearing',
  'Speed',
  'TimeStamp',
  'Status.Active',
  'Deleted',
];

/**
 * Delays come from TrainAnnouncement: each station call a train has made,
 * with its timetabled and actual time. One query covers the minutes since the
 * last refresh (at most DELAY_WINDOW_MS), at most once per DELAY_REFRESH_MS,
 * and the newest call per train is kept for DELAY_KEEP_MS, so a position poll
 * costs nothing extra between refreshes. Station names (TrainStation) are
 * fetched once a day.
 */
export const DELAY_REFRESH_MS = 60_000;
const DELAY_WINDOW_MS = 30 * 60_000;
const DELAY_KEEP_MS = 3 * 60 * 60_000;
const STATIONS_REFRESH_MS = 24 * 60 * 60_000;
const DELAY_MAX_BODY_BYTES = 16 * 1024 * 1024;
// Product, owner and origin only sort a train into the Rail layer's service
// categories (railFeeds.js, swedenTrain); the Transit card does not read them.
const ANNOUNCEMENT_FIELDS = [
  'OperationalTrainNumber',
  'LocationSignature',
  'AdvertisedTimeAtLocation',
  'TimeAtLocation',
  'ActivityType',
  'ToLocation',
  'FromLocation',
  'ProductInformation',
  'InformationOwner',
];
/** Station fields: the country tells a train that ends abroad. */
const STATION_FIELDS = [
  'LocationSignature',
  'AdvertisedShortLocationName',
  'CountryCode',
];

/** Escape a value for an XML attribute. */
function xmlAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The XML query for every train that reported since `sinceIso`.
 * @param {string} key Trafikverket API key.
 * @param {string} sinceIso ISO-8601 lower bound for `TimeStamp`.
 * @returns {string}
 */
export function trafikverketTrainQuery(key, sinceIso) {
  const include = TRAIN_FIELDS.map((f) => `<INCLUDE>${f}</INCLUDE>`).join('');
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1">' +
    '<FILTER>' +
    `<GT name="TimeStamp" value="${xmlAttr(sinceIso)}" />` +
    '<EQ name="Deleted" value="false" />' +
    '</FILTER>' +
    include +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** `POINT (18.0686 59.3293)` -> {lon, lat}, or null. */
function parseWgs84Point(text) {
  const match = /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(
    String(text ?? ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Train numbers are short digit strings; anything else is refused. */
function trainNumber(value) {
  const text = String(value ?? '').trim();
  return /^[0-9A-Za-z]{1,12}$/.test(text) ? text : null;
}

/** A finite number, or null for absent and non-numeric values. */
function finiteOrNull(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * One `TrainPosition` record -> one Transit vehicle record, or null.
 *
 * The vehicle id is the operational train number plus its departure date, so
 * one run keeps one id all day (trails and interpolation follow it) while the
 * same number on another day is a different train. The advertised number is
 * the one on the departure boards, so it is the route a rider would say.
 *
 * @param {object} record One element of RESULT[0].TrainPosition.
 * @returns {object|null}
 */
export function trafikverketTrainToVehicle(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.Deleted === true || record.Status?.Active === false) return null;
  const point = parseWgs84Point(record.Position?.WGS84);
  if (!point) return null;
  if (Math.abs(point.lat) < 1e-6 && Math.abs(point.lon) < 1e-6) return null;
  const operational = trainNumber(record.Train?.OperationalTrainNumber);
  const advertised =
    trainNumber(record.Train?.AdvertisedTrainNumber) || operational;
  if (!operational) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(
    String(record.Train?.OperationalTrainDepartureDate ?? ''),
  );
  const id = day
    ? `${operational}-${day[1]}${day[2]}${day[3]}`
    : `${operational}`;
  const measured = Date.parse(String(record.TimeStamp ?? ''));
  const bearing = finiteOrNull(record.Bearing);
  const speedKmh = finiteOrNull(record.Speed);
  return {
    id,
    lat: Number(point.lat.toFixed(6)),
    lon: Number(point.lon.toFixed(6)),
    bearing: bearing === null ? null : ((bearing % 360) + 360) % 360,
    speedMps:
      speedKmh === null || speedKmh < 0
        ? null
        : Number((speedKmh / 3.6).toFixed(2)),
    timestamp: Number.isFinite(measured) ? Math.floor(measured / 1000) : null,
    routeId: advertised,
    tripId: id,
    directionId: null,
    label: `Tåg ${advertised}`,
    stopId: null,
    status: null,
    occupancy: null,
  };
}

/**
 * Flatten an API answer into vehicles. Duplicate ids keep the newest report.
 * @param {object} payload Parsed JSON body.
 * @returns {{ vehicles: object[], entityCount: number, truncated: boolean }}
 */
export function trafikverketTrainsToVehicles(payload) {
  const result = payload?.RESPONSE?.RESULT?.[0];
  if (result?.ERROR) {
    const error = new Error(
      `Trafikverket refused the query: ${String(
        result.ERROR.MESSAGE || result.ERROR.SOURCE || 'error',
      ).slice(0, 200)}`,
    );
    error.upstreamStatus = result.ERROR.SOURCE === 'Security' ? 401 : 400;
    throw error;
  }
  const records = Array.isArray(result?.TrainPosition)
    ? result.TrainPosition
    : [];
  const truncated = records.length > TRAFIKVERKET_TRAINS_MAX_RECORDS;
  const byId = new Map();
  for (const record of records.slice(0, TRAFIKVERKET_TRAINS_MAX_RECORDS)) {
    const vehicle = trafikverketTrainToVehicle(record);
    if (!vehicle) continue;
    const existing = byId.get(vehicle.id);
    if (!existing || (vehicle.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byId.set(vehicle.id, vehicle);
    }
  }
  return {
    vehicles: [...byId.values()],
    entityCount: records.length,
    truncated,
  };
}

/**
 * The XML query for station calls since `sinceIso`, plus the station list
 * when `withStations`.
 * @param {string} key
 * @param {string} sinceIso
 * @param {boolean} withStations
 * @returns {string}
 */
export function trafikverketDelayQuery(key, sinceIso, withStations) {
  const include = (fields) =>
    fields.map((f) => `<INCLUDE>${f}</INCLUDE>`).join('');
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="TrainAnnouncement" schemaversion="1.9">' +
    '<FILTER><AND>' +
    `<GT name="TimeAtLocation" value="${xmlAttr(sinceIso)}" />` +
    '<EXISTS name="AdvertisedTimeAtLocation" value="true" />' +
    '</AND></FILTER>' +
    include(ANNOUNCEMENT_FIELDS) +
    '</QUERY>' +
    (withStations
      ? '<QUERY objecttype="TrainStation" schemaversion="1.4">' +
        '<FILTER><EQ name="Advertised" value="true" /></FILTER>' +
        include(STATION_FIELDS) +
        '</QUERY>'
      : '') +
    '</REQUEST>'
  );
}

/** The terminal of an ordered `FromLocation`/`ToLocation` list, or null. */
function endLocation(list, last) {
  const sorted = (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => (a?.Order ?? 0) - (b?.Order ?? 0));
  return (
    String((last ? sorted.at(-1) : sorted[0])?.LocationName ?? '').slice(
      0,
      12,
    ) || null
  );
}

/** A short text field, or null. */
function shortText(value, max = 40) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Fold station calls into the newest call per operational train number.
 * A call that leaves out the product, owner or origin keeps the train's
 * earlier ones: they describe the train, not the call.
 * @param {object[]} records TrainAnnouncement records.
 * @param {Map<string, object>} byTrain Updated in place.
 */
export function foldTrainCalls(records, byTrain) {
  for (const record of Array.isArray(records) ? records : []) {
    const train = trainNumber(record?.OperationalTrainNumber);
    const actual = Date.parse(String(record?.TimeAtLocation ?? ''));
    const planned = Date.parse(String(record?.AdvertisedTimeAtLocation ?? ''));
    if (!train || !Number.isFinite(actual) || !Number.isFinite(planned))
      continue;
    const previous = byTrain.get(train);
    if (previous && previous.at > actual) continue;
    byTrain.set(train, {
      at: actual,
      delayMinutes: Math.round((actual - planned) / 60_000),
      station: String(record.LocationSignature ?? '').slice(0, 12) || null,
      departed: /avg/i.test(String(record.ActivityType ?? '')),
      destination: endLocation(record.ToLocation, true),
      origin:
        endLocation(record.FromLocation, false) ?? previous?.origin ?? null,
      product:
        shortText(record.ProductInformation?.[0]?.Description) ??
        previous?.product ??
        null,
      owner: shortText(record.InformationOwner) ?? previous?.owner ?? null,
    });
  }
}

/** Per-process delay state; one refresh in flight at a time. */
const delayState = {
  refreshedAt: 0,
  byTrain: new Map(),
  stations: new Map(),
  /** Signatures of stations outside Sweden (TrainStation CountryCode). */
  abroad: new Set(),
  stationsAt: 0,
  inFlight: null,
};

/**
 * The last shared positions snapshot (or failure) and the request under way,
 * each tagged with the key it was asked with (sharedTrainSnapshot).
 */
const sharedState = {
  /** @type {{key: string, at: number, value?: object, error?: Error}|null} */
  result: null,
  /** @type {{key: string, promise: Promise<object>}|null} */
  inFlight: null,
};

/** Forget every delay, station and shared snapshot (tests). */
export function resetTrainDelays() {
  delayState.refreshedAt = 0;
  delayState.byTrain = new Map();
  delayState.stations = new Map();
  delayState.abroad = new Set();
  delayState.stationsAt = 0;
  delayState.inFlight = null;
  sharedState.result = null;
  sharedState.inFlight = null;
}

async function refreshTrainDelays({ key, fetchImpl, now, signal }) {
  const withStations = now - delayState.stationsAt > STATIONS_REFRESH_MS;
  const since = new Date(
    Math.max(now - DELAY_WINDOW_MS, delayState.refreshedAt - 2 * 60_000),
  ).toISOString();
  const response = await fetchImpl(TRAFIKVERKET_API_URL, {
    method: 'POST',
    signal,
    redirect: 'manual',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      Accept: 'application/json',
    },
    body: trafikverketDelayQuery(key, since, withStations),
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw new Error(`delays upstream HTTP ${response.status}`);
  }
  const bytes = await readResponseBytesCapped(response, DELAY_MAX_BODY_BYTES);
  const results = JSON.parse(new TextDecoder().decode(bytes))?.RESPONSE?.RESULT;
  if (!Array.isArray(results) || results.some((result) => result?.ERROR))
    throw new Error('delays query refused');
  foldTrainCalls(results[0]?.TrainAnnouncement, delayState.byTrain);
  const stations = results[1]?.TrainStation;
  if (withStations && Array.isArray(stations)) {
    delayState.stations = new Map(
      stations
        .filter((row) => row?.LocationSignature)
        .map((row) => [
          String(row.LocationSignature),
          String(row.AdvertisedShortLocationName || row.LocationSignature),
        ]),
    );
    delayState.abroad = new Set(
      stations
        .filter(
          (row) =>
            row?.LocationSignature &&
            /^[A-Z]{2}$/.test(String(row.CountryCode ?? '')) &&
            row.CountryCode !== 'SE',
        )
        .map((row) => String(row.LocationSignature)),
    );
    delayState.stationsAt = now;
  }
  for (const [train, call] of delayState.byTrain)
    if (now - call.at > DELAY_KEEP_MS) delayState.byTrain.delete(train);
  delayState.refreshedAt = now;
}

/**
 * Add the newest delay, station and destination to each train that has one.
 * A failed delay refresh keeps the last known delays; positions never wait
 * on it for longer than the one request.
 * @param {object[]} vehicles From trafikverketTrainsToVehicles.
 * @returns {object[]}
 */
export async function withTrainDelays(
  vehicles,
  { key, fetchImpl = fetch, now = Date.now(), signal } = {},
) {
  if (now - delayState.refreshedAt >= DELAY_REFRESH_MS) {
    delayState.inFlight ??= refreshTrainDelays({
      key,
      fetchImpl,
      now,
      signal,
    }).finally(() => {
      delayState.inFlight = null;
    });
    try {
      await delayState.inFlight;
    } catch (error) {
      console.warn(`[trafikverket-trains] ${error?.message || error}`);
      delayState.refreshedAt = now;
    }
  }
  const name = (signature) =>
    signature ? delayState.stations.get(signature) || signature : null;
  return vehicles.map((vehicle) => {
    const call = delayState.byTrain.get(vehicle.id.split('-')[0]);
    if (!call) return vehicle;
    return {
      ...vehicle,
      delayMinutes: call.delayMinutes,
      lastStation: name(call.station),
      lastStationDeparted: call.departed,
      destination: name(call.destination),
    };
  });
}

/** How long one fetched snapshot answers every layer that asks (ms). */
export const TRAFIKVERKET_TRAINS_SHARE_MS = TRANSIT_PROXY_TTL_MS;

/**
 * What the Rail layer sorts a train by, from its newest station call: the
 * product and owner Trafikverket publishes, its origin's name, and whether
 * either end of its run is a station outside Sweden. Null for a train that
 * has made no call yet.
 * @param {object} vehicle
 * @returns {{product: string|null, operator: string|null,
 *   origin: string|null, abroad: boolean}|null}
 */
function trainServiceOf(vehicle) {
  const call = delayState.byTrain.get(vehicle.id.split('-')[0]);
  if (!call) return null;
  return {
    product: call.product,
    operator: call.owner,
    origin: call.origin
      ? delayState.stations.get(call.origin) || call.origin
      : null,
    abroad: [call.origin, call.destination].some(
      (signature) => signature && delayState.abroad.has(signature),
    ),
  };
}

/** Wait for a shared promise, but stop waiting when this caller aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One positions request plus the delay refresh it may carry. It runs on its
 * own abort and timeout, not on the asking layer's: a second layer waiting on
 * the same request must not lose it when the first one gives up.
 */
async function fetchSharedSnapshot({ key, fetchImpl, now }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TRANSIT_PROXY_TIMEOUT_MS,
  );
  try {
    const since = new Date(now - TRAFIKVERKET_TRAINS_MAX_AGE_MS).toISOString();
    const response = await fetchImpl(TRAFIKVERKET_API_URL, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'application/json',
        'User-Agent':
          'gods-eye-view-transit-proxy/1.0 (+https://github.com/Kajjan7610/Gods-view-sweden)',
      },
      body: trafikverketTrainQuery(key, since),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      const error = new Error(`upstream HTTP ${response.status}`);
      error.upstreamStatus = response.status;
      throw error;
    }
    const bytes = await readResponseBytesCapped(
      response,
      TRAFIKVERKET_TRAINS_MAX_BODY_BYTES,
    );
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const {
      vehicles: positions,
      entityCount,
      truncated,
    } = trafikverketTrainsToVehicles(payload);
    const vehicles = await withTrainDelays(positions, {
      key,
      fetchImpl,
      now,
      signal: controller.signal,
    });
    const services = new Map();
    for (const vehicle of vehicles) {
      const service = trainServiceOf(vehicle);
      if (service) services.set(vehicle.id, service);
    }
    return {
      host: new URL(TRAFIKVERKET_API_URL).hostname,
      fetchedAt: now,
      entityCount,
      truncated,
      vehicles,
      services,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The positions snapshot both layers read. A snapshot (or a failure) younger
 * than TRAFIKVERKET_TRAINS_SHARE_MS answers every caller with the same key,
 * and callers that ask while a request is under way share it, so watching
 * Transit and Rail at once costs Trafikverket no more than either alone: at
 * most four position requests a minute, plus the delay refresh once a
 * minute and the station list once a day (withTrainDelays). A failure is
 * kept for the same window, so the two layers do not each retry it.
 *
 * @param {{key: string, fetchImpl?: typeof fetch, now?: number,
 *   signal?: AbortSignal}} options
 * @returns {Promise<{host: string, fetchedAt: number, entityCount: number,
 *   truncated: boolean, vehicles: object[], services: Map<string, object>}>}
 */
export async function sharedTrainSnapshot({
  key,
  fetchImpl = fetch,
  now = Date.now(),
  signal,
} = {}) {
  const kept = sharedState.result;
  if (
    kept &&
    kept.key === key &&
    now >= kept.at &&
    now - kept.at < TRAFIKVERKET_TRAINS_SHARE_MS
  ) {
    if (kept.error) throw kept.error;
    return kept.value;
  }
  if (sharedState.inFlight?.key !== key) {
    const flight = {
      key,
      promise: fetchSharedSnapshot({ key, fetchImpl, now }),
    };
    sharedState.inFlight = flight;
    const settle = (outcome) => {
      if (sharedState.inFlight !== flight) return;
      sharedState.result = { key, at: now, ...outcome };
      sharedState.inFlight = null;
    };
    flight.promise.then(
      (value) => settle({ value }),
      (error) => settle({ error }),
    );
  }
  return untilAborted(sharedState.inFlight.promise, signal);
}

/**
 * Fetch one snapshot, in the shape `buildTransitSnapshot` produces.
 *
 * @param {object} feed Registry entry.
 * @param {{key: string, signal?: AbortSignal, fetchImpl?: typeof fetch, now?: number}} options
 * @returns {Promise<{snapshot: object, host: string}>}
 */
export async function fetchTrafikverketTrainSnapshot(
  feed,
  { key, signal, fetchImpl = fetch, now = Date.now() },
) {
  const shared = await sharedTrainSnapshot({ key, signal, fetchImpl, now });
  const { vehicles, fetchedAt } = shared;
  return {
    host: shared.host,
    snapshot: {
      feedId: feed.id,
      name: feed.name,
      fetchedAt,
      // The API has no snapshot header time, so a position without its own
      // TimeStamp falls back to fetch time, labelled as the guess it is.
      feedTimestamp: null,
      version: null,
      entityCount: shared.entityCount,
      truncated: shared.truncated,
      count: vehicles.length,
      vehicles: repairVehicleTimestamps(
        vehicles,
        null,
        Math.floor(fetchedAt / 1000),
      ),
    },
  };
}

/**
 * The shared snapshot's trains as the Rail layer reads them, before its
 * classifier (railFeeds.js, `swedenTrain`): the Transit record plus the
 * destination as `headsign`, a label that names the product ("Pågatåg
 * 1043", else the Transit label "Tåg 1043"), and the product, owner, origin
 * and `abroad` the classifier sorts by.
 * @param {Awaited<ReturnType<typeof sharedTrainSnapshot>>} shared
 * @returns {object[]}
 */
export function trafikverketRailVehicles(shared) {
  const fetchedS = Math.floor(shared.fetchedAt / 1000);
  return repairVehicleTimestamps(shared.vehicles, null, fetchedS).map(
    (vehicle) => {
      const service = shared.services?.get(vehicle.id) ?? null;
      return {
        ...vehicle,
        label: service?.product
          ? `${service.product} ${vehicle.routeId}`
          : vehicle.label,
        headsign: vehicle.destination ?? null,
        product: service?.product ?? null,
        operator: service?.operator ?? null,
        origin: service?.origin ?? null,
        abroad: service?.abroad === true,
      };
    },
  );
}
