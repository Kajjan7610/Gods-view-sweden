import {
  MAX_AGE_MS,
  normalizeQueueSnapshot,
} from '../../src/layers/roadQueues/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// Trafikverket's measured traffic: travel times on its stretches and the
// detectors' flow and speed against the normal for the hour (TrafficFlow
// 1.6, BaselineTraffic). The detectors report every minute; one minute of
// cache follows them. The layer and the city dossier share the snapshot.
const TTL_MS = 60_000;

const ROUTE_FIELDS = [
  'Id',
  'Name',
  'Deleted',
  'TrafficStatus',
  'TravelTime',
  'FreeFlowTravelTime',
  'ExpectedFreeFlowTravelTime',
  'Speed',
  'Length',
  'MeasureTime',
  'Geometry.WGS84',
];
const FLOW_FIELDS = [
  'SiteId',
  'Deleted',
  'MeasurementSide',
  'VehicleType',
  'VehicleFlowRate',
  'AverageVehicleSpeed',
  'BaselineTraffic.Flow.Mean',
  'BaselineTraffic.Speed.Mean',
  'BaselineTraffic.Speed.StdDev',
  'MeasurementTime',
  'CountyNo',
  'DataQuality',
  'Geometry.WGS84',
];

/** The TravelTimeRoute and TrafficFlow request body. */
export function trafikverketQueuesQuery(key, nowMs = Date.now()) {
  const since = new Date(nowMs - MAX_AGE_MS).toISOString();
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="TravelTimeRoute" namespace="Road.TrafficInfo" schemaversion="1.6" limit="2000">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(ROUTE_FIELDS) +
    '</QUERY>' +
    '<QUERY objecttype="TrafficFlow" namespace="Road.TrafficInfo" schemaversion="1.6" limit="20000">' +
    '<FILTER><AND>' +
    `<GT name="MeasurementTime" value="${since}" />` +
    '<EQ name="VehicleType" value="anyVehicle" />' +
    '</AND></FILTER>' +
    include(FLOW_FIELDS) +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket queues and travel times for dev and preview. */
export function trafikverketQueuesProxy(options = {}) {
  const now = options.now ?? (() => Date.now());
  return trafikverketProxy({
    name: 'trafikverket-queues',
    query: (key) => trafikverketQueuesQuery(key, now()),
    normalize: normalizeQueueSnapshot,
    describe: (value) =>
      `${value.routes.length} travel-time stretches (${
        value.routes.filter((route) => route.status !== 'freeflow').length
      } not free), ${value.points.length} measuring points (${
        value.points.filter((point) => point.status === 'queue').length
      } queued)`,
    keylessHint: 'Swedish queues and travel times',
    ttlMs: TTL_MS,
    ...options,
  });
}
