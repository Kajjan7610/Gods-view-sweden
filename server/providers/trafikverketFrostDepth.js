import { normalizeFrostDepthSnapshot } from '../../src/layers/frostDepth/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// The frost depth points sample every few hours; half an hour of cache is
// plenty.
const TTL_MS = 30 * 60_000;

const POINT_FIELDS = [
  'Id',
  'Name',
  'Deleted',
  'Geometry.WGS84',
  'FrostDepth.Sample',
  'FrostDepth.Temperature.Depth',
  'FrostDepth.Temperature.Value',
];

/** The FrostDepthMeasurepoint request body. */
export function trafikverketFrostDepthQuery(key) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="FrostDepthMeasurepoint" namespace="Road.WeatherInfo" schemaversion="1.0">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(POINT_FIELDS) +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket frost depth route for dev and preview. */
export function trafikverketFrostDepthProxy(options = {}) {
  return trafikverketProxy({
    name: 'trafikverket-frost-depth',
    query: trafikverketFrostDepthQuery,
    normalize: normalizeFrostDepthSnapshot,
    describe: (value) =>
      `${value.points.length} frost depth points, ${
        value.points.filter((row) => row.frost).length
      } with frozen ground, ${value.silent} not reporting`,
    keylessHint: 'Swedish frost depth',
    ttlMs: TTL_MS,
    ...options,
  });
}
