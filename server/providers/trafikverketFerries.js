import {
  LOOK_AHEAD_MS,
  normalizeFerrySnapshot,
} from '../../src/layers/roadFerries/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// Trafikverket's road ferries change their departures by the minute only
// when something happens; two minutes of cache keeps the list current.
const TTL_MS = 2 * 60_000;

const ROUTE_FIELDS = [
  'Id',
  'Name',
  'Shortname',
  'Deleted',
  'DeviationId',
  'Geometry.WGS84',
  'Type.Name',
  'Harbor.Name',
  'Harbor.SortOrder',
];
const DEPARTURE_FIELDS = [
  'Id',
  'Deleted',
  'DepartureTime',
  'DeviationId',
  'Info',
  'FromHarbor.Name',
  'ToHarbor.Name',
  'Route.Id',
];
const MESSAGE_FIELDS = ['Id', 'Header', 'Message'];

/** The FerryRoute, FerryAnnouncement and ferry Situation request body. */
export function trafikverketFerriesQuery(key, nowMs = Date.now()) {
  const from = new Date(nowMs - 5 * 60_000).toISOString();
  const to = new Date(nowMs + LOOK_AHEAD_MS).toISOString();
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="FerryRoute" namespace="Ferry.TrafficInfo" schemaversion="1.2">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(ROUTE_FIELDS) +
    '</QUERY>' +
    '<QUERY objecttype="FerryAnnouncement" namespace="Ferry.TrafficInfo" schemaversion="1.2" orderby="DepartureTime">' +
    '<FILTER><AND>' +
    '<EQ name="Deleted" value="false" />' +
    `<GT name="DepartureTime" value="${from}" />` +
    `<LT name="DepartureTime" value="${to}" />` +
    '</AND></FILTER>' +
    include(DEPARTURE_FIELDS) +
    '</QUERY>' +
    '<QUERY objecttype="Situation" namespace="Road.TrafficInfo" schemaversion="1.6">' +
    '<FILTER><AND>' +
    '<EQ name="Deleted" value="false" />' +
    '<EQ name="Deviation.MessageType" value="Färjor" />' +
    '</AND></FILTER>' +
    '<INCLUDE>Deleted</INCLUDE>' +
    include(MESSAGE_FIELDS, 'Deviation.') +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket road ferry route for dev and preview. */
export function trafikverketFerriesProxy(options = {}) {
  const now = options.now ?? (() => Date.now());
  return trafikverketProxy({
    name: 'trafikverket-ferries',
    query: (key) => trafikverketFerriesQuery(key, now()),
    normalize: normalizeFerrySnapshot,
    describe: (value) =>
      `${value.routes.length} ferry routes, ${
        value.routes.filter((route) => route.messages.length).length
      } with messages`,
    keylessHint: 'Swedish road ferries',
    ttlMs: TTL_MS,
    ...options,
  });
}
