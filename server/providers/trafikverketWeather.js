import { normalizeWeatherSnapshot } from '../../src/layers/roadWeather/records.js';
import {
  trafikverketIncludes as include,
  trafikverketProxy,
  xmlAttr,
} from './trafikverketProxy.js';

// Road weather stations sample every 5 to 10 minutes.
const TTL_MS = 5 * 60_000;

const STATION_FIELDS = [
  'Id',
  'Name',
  'Deleted',
  'Geometry.WGS84',
  'Observation.Sample',
  'Observation.Weather.Precipitation',
  'Observation.Surface.Temperature.Value',
  'Observation.Surface.Ice',
  'Observation.Surface.Snow',
  'Observation.Surface.Water',
  'Observation.Surface.Grip.Value',
  'Observation.Air.Temperature.Value',
  'Observation.Air.Dewpoint.Value',
  'Observation.Air.RelativeHumidity.Value',
  'Observation.Air.VisibleDistance.Value',
  'Observation.Wind.Speed.Value',
  'Observation.Wind.Direction.Value',
  'Observation.Aggregated10minutes.Wind.SpeedMax.Value',
  'Observation.Aggregated30minutes.Precipitation.TotalWaterEquivalent.Value',
];

/** The WeatherMeasurepoint request body. */
export function trafikverketWeatherQuery(key) {
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="WeatherMeasurepoint" namespace="Road.WeatherInfo" schemaversion="2.1">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(STATION_FIELDS) +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket road weather route for dev and preview. */
export function trafikverketWeatherProxy(options = {}) {
  return trafikverketProxy({
    name: 'trafikverket-weather',
    query: trafikverketWeatherQuery,
    normalize: normalizeWeatherSnapshot,
    describe: (value) =>
      `${value.stations.length} road weather stations, ${
        value.stations.filter((row) => row.risk).length
      } with risk of ice`,
    keylessHint: 'Swedish road weather',
    ttlMs: TTL_MS,
    ...options,
  });
}
