/**
 * Trafikverket (Sweden) live train positions for the Transit layer.
 *
 * Trafikverket publishes train GPS positions as the `TrainPosition` object of
 * its open traffic API (CC0 1.0) rather than as GTFS-Realtime, so this module
 * stands in for the protobuf decoder: it POSTs one XML query and flattens the
 * JSON answer into the same vehicle records `decodeVehiclePositions` returns.
 *
 * The API needs a free key (TRAFIKVERKET_API_KEY). The key is read by the
 * server-side transit service and only ever travels in the request body to
 * Trafikverket; it is never logged and never reaches the browser.
 */

import { readResponseBytesCapped } from './httpBody.js';
import { repairVehicleTimestamps } from '../data/transitProxy.js';

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
const ANNOUNCEMENT_FIELDS = [
  'OperationalTrainNumber',
  'LocationSignature',
  'AdvertisedTimeAtLocation',
  'TimeAtLocation',
  'ActivityType',
  'ToLocation',
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
        include(['LocationSignature', 'AdvertisedShortLocationName']) +
        '</QUERY>'
      : '') +
    '</REQUEST>'
  );
}

/**
 * Fold station calls into the newest call per operational train number.
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
    const to = Array.isArray(record.ToLocation) ? record.ToLocation : [];
    byTrain.set(train, {
      at: actual,
      delayMinutes: Math.round((actual - planned) / 60_000),
      station: String(record.LocationSignature ?? '').slice(0, 12) || null,
      departed: /avg/i.test(String(record.ActivityType ?? '')),
      destination:
        String(
          [...to].sort((a, b) => (a?.Order ?? 0) - (b?.Order ?? 0)).at(-1)
            ?.LocationName ?? '',
        ).slice(0, 12) || null,
    });
  }
}

/** Per-process delay state; one refresh in flight at a time. */
const delayState = {
  refreshedAt: 0,
  byTrain: new Map(),
  stations: new Map(),
  stationsAt: 0,
  inFlight: null,
};

/** Forget every delay and station (tests). */
export function resetTrainDelays() {
  delayState.refreshedAt = 0;
  delayState.byTrain = new Map();
  delayState.stations = new Map();
  delayState.stationsAt = 0;
  delayState.inFlight = null;
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
  const since = new Date(now - TRAFIKVERKET_TRAINS_MAX_AGE_MS).toISOString();
  const response = await fetchImpl(TRAFIKVERKET_API_URL, {
    method: 'POST',
    signal,
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
    signal,
  });
  return {
    host: new URL(TRAFIKVERKET_API_URL).hostname,
    snapshot: {
      feedId: feed.id,
      name: feed.name,
      fetchedAt: now,
      // The API has no snapshot header time, so a position without its own
      // TimeStamp falls back to fetch time, labelled as the guess it is.
      feedTimestamp: null,
      version: null,
      entityCount,
      truncated,
      count: vehicles.length,
      vehicles: repairVehicleTimestamps(vehicles, null, Math.floor(now / 1000)),
    },
  };
}
