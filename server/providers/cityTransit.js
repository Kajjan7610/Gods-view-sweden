import { sameSiteGated } from './common/same-site.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { TRAFIKVERKET_API_URL, xmlAttr } from './trafikverketProxy.js';
import { greatCircleKm } from '../../src/geoDistance.js';
import { createSwedaviaFlights } from './cityFlights.js';
import { createAirportIndex } from './ourAirports.js';

// The city dossier's live transport: the next departures from the town's
// railway station (Trafikverket, CC0, the existing TRAFIKVERKET_API_KEY) and
// the traffic jams around it (TomTom Traffic Incidents, the existing
// TOMTOM_API_KEY), plus the nearby Swedavia airports' flights (cityFlights.js).
// Keys stay server-side; each part is simply absent without its key. Stations are read once a day, departures every minute,
// jams every five minutes per town.

export const TOMTOM_INCIDENTS_URL =
  'https://api.tomtom.com/traffic/services/5/incidentDetails';
const STATIONS_TTL_MS = 24 * 60 * 60_000;
const DEPARTURES_TTL_MS = 60_000;
const JAMS_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;
/** The town's station lies within this distance of its seat. */
const STATION_RADIUS_KM = 8;
/** Jams are looked for within this distance of the seat. */
const JAM_RADIUS_KM = 12;
const MAX_DEPARTURES = 6;
const MAX_JAMS = 3;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const JAM_FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code},startTime,from,to,length,delay,roadNumbers}}}';

const text = (value, max = 80) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** Trafikverket's advertised stations with a position. */
export function normalizeStations(payload) {
  const rows = payload?.RESPONSE?.RESULT?.[0]?.TrainStation;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const match = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(
        String(row?.Geometry?.WGS84 ?? ''),
      );
      return match && row?.LocationSignature
        ? {
            signature: String(row.LocationSignature).slice(0, 12),
            name: text(row.AdvertisedLocationName) || row.LocationSignature,
            lon: Number(match[1]),
            lat: Number(match[2]),
          }
        : null;
    })
    .filter(Boolean);
}

/**
 * The town's station: one named after the town ("Gävle C") within reach,
 * else the nearest station within reach, else null.
 */
export function townStation(stations, point, townName) {
  const name = String(townName ?? '').toLocaleLowerCase('sv-SE');
  const near = stations
    .map((station) => ({
      station,
      km: greatCircleKm(
        { lat: point.latitude, lon: point.longitude },
        { lat: station.lat, lon: station.lon },
      ),
    }))
    .filter((row) => row.km <= STATION_RADIUS_KM)
    .sort((a, b) => a.km - b.km);
  const lower = (row) => row.station.name.toLocaleLowerCase('sv-SE');
  // The central station first ("Stockholm C" before "Stockholm City"), then
  // the town's own name, then any station named after it.
  const named =
    near.find((row) => lower(row) === `${name} c`) ||
    near.find((row) => lower(row) === name) ||
    near.find((row) => lower(row).startsWith(name));
  return (named || near[0])?.station ?? null;
}

/** Departures from one station over the next three hours, soonest first. */
export function departuresQuery(key, signature, nowMs) {
  const from = new Date(nowMs - 10 * 60_000).toISOString();
  const to = new Date(nowMs + 3 * 3600_000).toISOString();
  const include = [
    'AdvertisedTimeAtLocation',
    'EstimatedTimeAtLocation',
    'TimeAtLocation',
    'ToLocation',
    'ProductInformation',
    'TrackAtLocation',
    'Canceled',
    'AdvertisedTrainIdent',
    'Deviation',
  ]
    .map((field) => `<INCLUDE>${field}</INCLUDE>`)
    .join('');
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="AdvertisedTimeAtLocation" limit="${MAX_DEPARTURES * 2}">` +
    '<FILTER><AND>' +
    `<EQ name="LocationSignature" value="${xmlAttr(signature)}" />` +
    '<EQ name="ActivityType" value="Avgang" />' +
    '<EQ name="Advertised" value="true" />' +
    // A late train stays for as long as it is still expected, however long
    // ago it was due; one that has left is not asked for at all.
    '<OR>' +
    `<GT name="AdvertisedTimeAtLocation" value="${from}" />` +
    `<GT name="EstimatedTimeAtLocation" value="${from}" />` +
    '</OR>' +
    `<LT name="AdvertisedTimeAtLocation" value="${to}" />` +
    '<EXISTS name="TimeAtLocation" value="false" />' +
    '</AND></FILTER>' +
    include +
    '</QUERY></REQUEST>'
  );
}

/**
 * Departures still to leave (or just left late), with destination names,
 * expected time, delay, track and the reason Trafikverket gives.
 * @param {object} payload
 * @param {Map<string, string>} names Signature → station name.
 * @param {number} nowMs
 */
export function normalizeDepartures(payload, names, nowMs) {
  const rows = payload?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const planned = Date.parse(String(row?.AdvertisedTimeAtLocation ?? ''));
    if (!Number.isFinite(planned)) continue;
    const departed = Date.parse(String(row.TimeAtLocation ?? ''));
    const estimated = Date.parse(String(row.EstimatedTimeAtLocation ?? ''));
    // A train that has left is no longer a departure.
    if (Number.isFinite(departed)) continue;
    const expected = Number.isFinite(estimated) ? estimated : planned;
    if (expected < nowMs - 2 * 60_000) continue;
    const to = (Array.isArray(row.ToLocation) ? row.ToLocation : [])
      .slice()
      .sort((a, b) => (a?.Order ?? 0) - (b?.Order ?? 0))
      .at(-1)?.LocationName;
    out.push({
      train: text(row.AdvertisedTrainIdent, 12),
      planned,
      expected,
      delayMinutes: Math.max(0, Math.round((expected - planned) / 60_000)),
      canceled: row.Canceled === true,
      destination: names.get(String(to ?? '')) || text(to, 40),
      product: text(row.ProductInformation?.[0]?.Description, 40),
      // "x" is Trafikverket's no-track mark (a replacement bus).
      track: /^x$/i.test(String(row.TrackAtLocation ?? '').trim())
        ? null
        : text(row.TrackAtLocation, 8),
      note: text(row.Deviation?.[0]?.Description, 60),
    });
    if (out.length >= MAX_DEPARTURES) break;
  }
  return out;
}

/** A box of `km` around a point, as TomTom's minLon,minLat,maxLon,maxLat. */
export function boxAround(point, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((point.latitude * Math.PI) / 180));
  return [
    point.longitude - dLon,
    point.latitude - dLat,
    point.longitude + dLon,
    point.latitude + dLat,
  ]
    .map((value) => value.toFixed(4))
    .join(',');
}

/** TomTom's jams as the dossier lists them, longest delay first. */
export function normalizeJams(payload) {
  const rows = Array.isArray(payload?.incidents) ? payload.incidents : [];
  return rows
    .map((row) => row?.properties)
    .filter((props) => props && Number(props.iconCategory) === 6)
    .map((props) => ({
      roads: (Array.isArray(props.roadNumbers) ? props.roadNumbers : [])
        .map((road) => text(road, 12))
        .filter(Boolean)
        .slice(0, 3),
      description: text(props.events?.[0]?.description, 60),
      from: text(props.from, 80),
      to: text(props.to, 80),
      lengthM: Number.isFinite(Number(props.length))
        ? Math.round(Number(props.length))
        : null,
      delaySeconds: Number.isFinite(Number(props.delay))
        ? Math.round(Number(props.delay))
        : 0,
      magnitude: Number(props.magnitudeOfDelay) || 0,
    }))
    .sort(
      (a, b) => b.delaySeconds - a.delaySeconds || b.magnitude - a.magnitude,
    )
    .slice(0, MAX_JAMS);
}

/** A JSON writer for one response, never cached by the browser. */
const respond = (res) => (status, value) => {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
};

/** Bounded city transit and airport board routes for dev and preview. */
export function cityTransitProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  airportIndex = createAirportIndex({ fetchImpl, now }),
} = {}) {
  let stations = null;
  const departures = new Map();
  const jams = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function fetchJson(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        // The status only: request bodies and URLs carry keys.
        throw new Error(`upstream HTTP ${response.status}`);
      }
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  const postTrafikverket = (body) =>
    fetchJson(TRAFIKVERKET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'application/json',
      },
      body,
    });

  function cached(map, key, ttl, load) {
    const hit = map.get(key);
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.value);
    return coalesceProxyRequest(inFlight, `${ttl}:${key}`, async () => {
      const value = await load();
      map.delete(key);
      map.set(key, { value, at: now() });
      if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
      return value;
    }).promise;
  }

  /**
   * Every advertised station, read once a day by whoever asks first. An
   * answer without a single station is an answer gone wrong: it is not kept,
   * or every town would lack its station for a day.
   */
  function loadStations(key) {
    if (stations && now() - stations.at < STATIONS_TTL_MS)
      return Promise.resolve(stations.value);
    return coalesceProxyRequest(inFlight, 'stations', async () => {
      const value = normalizeStations(
        await postTrafikverket(
          '<REQUEST>' +
            `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
            '<QUERY objecttype="TrainStation" schemaversion="1.4">' +
            '<FILTER><EQ name="Advertised" value="true" /></FILTER>' +
            '<INCLUDE>LocationSignature</INCLUDE>' +
            '<INCLUDE>AdvertisedLocationName</INCLUDE>' +
            '<INCLUDE>Geometry.WGS84</INCLUDE>' +
            '</QUERY></REQUEST>',
        ),
      );
      if (!value.length) throw new Error('no stations in the answer');
      stations = { value, at: now() };
      return value;
    }).promise;
  }

  async function trains(point, townName) {
    const key = String(env.TRAFIKVERKET_API_KEY ?? '').trim();
    if (!key) return null;
    const list = await loadStations(key);
    const station = townStation(list, point, townName);
    if (!station) return { station: null, departures: [] };
    const names = new Map(list.map((row) => [row.signature, row.name]));
    return {
      station: station.name,
      departures: await cached(
        departures,
        station.signature,
        DEPARTURES_TTL_MS,
        async () =>
          normalizeDepartures(
            await postTrafikverket(
              departuresQuery(key, station.signature, now()),
            ),
            names,
            now(),
          ),
      ),
    };
  }

  // One Swedavia reader for the dossier and the airport board: both read the
  // same day lists, so the board costs no extra calls while the dossier shows.
  const swedavia = createSwedaviaFlights({ fetchJson, now, env });

  async function trafficJams(point, cacheKey) {
    const key = String(env.TOMTOM_API_KEY ?? '').trim();
    if (!key) return null;
    return cached(jams, cacheKey, JAMS_TTL_MS, async () =>
      normalizeJams(
        await fetchJson(
          `${TOMTOM_INCIDENTS_URL}?bbox=${boxAround(point, JAM_RADIUS_KM)}` +
            `&fields=${encodeURIComponent(JAM_FIELDS)}` +
            '&language=sv-SE&categoryFilter=6&timeValidityFilter=present' +
            `&key=${encodeURIComponent(key)}`,
          { headers: { Accept: 'application/json' } },
        ),
      ),
    );
  }

  async function handler(req, res) {
    const json = respond(res);
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const latitude = Number(url.searchParams.get('lat'));
    const longitude = Number(url.searchParams.get('lon'));
    const town = text(url.searchParams.get('town'), 60) || '';
    // Sweden and its nearest surroundings only: the keys are not spent on
    // anywhere else, and a missing value (read as 0) lies outside too.
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < 54 ||
      latitude > 70 ||
      longitude < 9 ||
      longitude > 25
    )
      return json(400, { error: 'lat_lon_required' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const point = { latitude, longitude };
    const cell = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const [rail, road, air] = await Promise.allSettled([
      trains(point, town),
      trafficJams(point, cell),
      swedavia.nearby(point),
    ]);
    for (const [label, result] of [
      ['trains', rail],
      ['jams', road],
      ['flights', air],
    ])
      if (result.status === 'rejected')
        console.warn(`[city-transit] ${label}: ${result.reason?.message}`);
    return json(200, {
      trains:
        rail.status === 'fulfilled'
          ? rail.value
          : { station: null, departures: [], error: true },
      jams:
        road.status === 'fulfilled'
          ? road.value === null
            ? null
            : { items: road.value }
          : { items: [], error: true },
      flights:
        air.status === 'fulfilled'
          ? air.value === null
            ? null
            : { airports: air.value }
          : { airports: [], error: true },
      fetchedAt: now(),
    });
  }

  /** One Swedavia airport's whole day: ?iata=ARN[&date=tomorrow][&only=security]. */
  async function boardHandler(req, res) {
    const json = respond(res);
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const date =
      url.searchParams.get('date') === 'tomorrow' ? 'tomorrow' : 'today';
    const only =
      url.searchParams.get('only') === 'security' ? 'security' : null;
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const board = await swedavia.board(url.searchParams.get('iata'), {
        date,
        only,
      });
      if (!board) return json(404, { error: 'unknown_airport' });
      return json(200, { ...board, fetchedAt: now() });
    } catch (error) {
      console.warn(`[airport-board] ${error?.message}`);
      return json(502, { error: 'upstream_failed' });
    }
  }

  /**
   * The followed aircraft's Swedavia rows:
   * ?callsign=SAS1427[&registration=SE-ROH][&airports=ARN,CPH].
   */
  async function flightHandler(req, res) {
    const json = respond(res);
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const field = (name) =>
      String(url.searchParams.get(name) ?? '')
        .replace(/[^A-Za-z0-9-]/g, '')
        .slice(0, 12);
    const callsign = field('callsign');
    const registration = field('registration');
    if (!callsign && !registration)
      return json(400, { error: 'callsign_or_registration_required' });
    const airports = String(url.searchParams.get('airports') ?? '')
      .split(',')
      .map((code) => code.replace(/[^A-Za-z]/g, '').slice(0, 4))
      .filter(Boolean)
      .slice(0, 4);
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const legs = await swedavia.findFlight({
        callsign,
        registration,
        airports,
      });
      return json(200, { legs, fetchedAt: now() });
    } catch (error) {
      console.warn(`[airport-flight] ${error?.message}`);
      return json(502, { error: 'upstream_failed' });
    }
  }

  /** Today's routes from a Swedavia airport, placed: ?iata=ARN. */
  async function routesHandler(req, res) {
    const json = respond(res);
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const day = await swedavia.routes(url.searchParams.get('iata'));
      if (!day) return json(404, { error: 'unknown_airport_or_no_key' });
      const places = await airportIndex.lookup(day.routes.map((r) => r.iata));
      return json(200, {
        ...day,
        routes: day.routes
          .filter((route) => places[route.iata])
          .map((route) => ({ ...route, ...places[route.iata] })),
        // Codes the airport list does not know, so the map leaves them out.
        unplaced: day.routes
          .filter((route) => !places[route.iata])
          .map((route) => route.iata),
        fetchedAt: now(),
      });
    } catch (error) {
      console.warn(`[airport-routes] ${error?.message}`);
      return json(502, { error: 'upstream_failed' });
    }
  }

  return {
    name: 'city-transit',
    configureServer({ middlewares }) {
      middlewares.use('/api/city-transit', sameSiteGated(handler));
      middlewares.use('/api/airport-board', sameSiteGated(boardHandler));
      middlewares.use('/api/airport-flight', sameSiteGated(flightHandler));
      middlewares.use('/api/airport-routes', sameSiteGated(routesHandler));
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/city-transit', sameSiteGated(handler));
      middlewares.use('/api/airport-board', sameSiteGated(boardHandler));
      middlewares.use('/api/airport-flight', sameSiteGated(flightHandler));
      middlewares.use('/api/airport-routes', sameSiteGated(routesHandler));
    },
  };
}
