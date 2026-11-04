import { normalizeRoadSnapshot } from '../../src/layers/roadConditions/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// One POST carries two queries: RoadCondition (winter road surface) and
// Situation (incidents).
const TTL_MS = 3 * 60_000;

const CONDITION_FIELDS = [
  'Id',
  'ConditionCode',
  'ConditionText',
  'ConditionInfo',
  'Warning',
  'Measure',
  'Cause',
  'RoadNumber',
  'LocationText',
  'StartTime',
  'EndTime',
  'Deleted',
  'Geometry.WGS84',
];
const DEVIATION_FIELDS = [
  'Id',
  'MessageType',
  'MessageCode',
  'Header',
  'Message',
  'SeverityCode',
  'SeverityText',
  'RoadNumber',
  'LocationDescriptor',
  'TrafficRestrictionType',
  'StartTime',
  'EndTime',
  'ValidUntilFurtherNotice',
  'Suspended',
  'WebLink',
  'Geometry.Point.WGS84',
  'Geometry.Line.WGS84',
];

/** The two-query request body. */
export function trafikverketRoadsQuery(key) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="RoadCondition" namespace="Road.TrafficInfo" schemaversion="1.3">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(CONDITION_FIELDS) +
    '</QUERY>' +
    '<QUERY objecttype="Situation" namespace="Road.TrafficInfo" schemaversion="1.6">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    '<INCLUDE>Id</INCLUDE><INCLUDE>Deleted</INCLUDE>' +
    include(DEVIATION_FIELDS, 'Deviation.') +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket road-condition and incident route for dev and preview. */
export function trafikverketRoadsProxy(options = {}) {
  return trafikverketProxy({
    name: 'trafikverket-roads',
    query: trafikverketRoadsQuery,
    normalize: normalizeRoadSnapshot,
    describe: (value) =>
      `${value.conditions.length} road-condition stretches, ${value.incidents.length} incidents`,
    keylessHint: 'Swedish road conditions and incidents',
    ttlMs: TTL_MS,
    ...options,
  });
}
