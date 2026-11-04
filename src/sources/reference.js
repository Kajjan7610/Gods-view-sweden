import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createDroneAirspaceSource } from '../layers/droneAirspace/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createTrafikverketRoadsSource } from '../layers/roadConditions/source.js';
import { createTrafikverketWeatherSource } from '../layers/roadWeather/source.js';
import { createSmhiWarningsSource } from '../layers/smhiWarnings/source.js';
import { createPolisenEventsSource } from '../layers/policeEvents/source.js';
import { createElectricityPricesSource } from '../layers/electricity/source.js';
import { createSrTrafficSource } from '../layers/srTraffic/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    'drone-airspace': createDroneAirspaceSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    'trafikverket-roads': createTrafikverketRoadsSource(),
    'trafikverket-weather': createTrafikverketWeatherSource(),
    'smhi-warnings': createSmhiWarningsSource(),
    'polisen-events': createPolisenEventsSource(),
    'electricity-prices': createElectricityPricesSource(),
    'sr-traffic': createSrTrafficSource(),
  };
}
