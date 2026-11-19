import { normalizeRestAreaSnapshot } from '../../src/layers/restAreas/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// The rest areas change when one opens, closes or is rebuilt; six hours of
// cache keeps the list current.
const TTL_MS = 6 * 60 * 60_000;

const AREA_FIELDS = [
  'Id',
  'Name',
  'Deleted',
  'Geometry.WGS84',
  'Description',
  'OpenStatus',
  'OperationStatus',
  'Equipment.Type',
  'Equipment.Accessibility',
  'VehicleCharacteristics.VehicleType',
  'VehicleCharacteristics.NumberOfSpaces',
  'TariffsAndPayment.FreeOfCharge',
];

/** The Parking request body. */
export function trafikverketRestAreasQuery(key) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="Parking" namespace="Road.Infrastructure" schemaversion="1.4">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(AREA_FIELDS) +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket rest area route for dev and preview. */
export function trafikverketRestAreasProxy(options = {}) {
  return trafikverketProxy({
    name: 'trafikverket-rest-areas',
    query: trafikverketRestAreasQuery,
    normalize: normalizeRestAreaSnapshot,
    describe: (value) =>
      `${value.areas.length} rest areas, ${
        value.areas.filter((row) => row.spaces.lorry > 0).length
      } with lorry spaces`,
    keylessHint: 'Swedish rest areas',
    ttlMs: TTL_MS,
    ...options,
  });
}
