import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import {
  createCombinedAirQualitySource,
  createEcccAirQualitySource,
  createSmhiAirQualitySource,
} from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createDroneAirspaceSource } from '../layers/droneAirspace/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createTrafikverketRoadsSource } from '../layers/roadConditions/source.js';
import { createTrafikverketWeatherSource } from '../layers/roadWeather/source.js';
import { createSmhiWarningsSource } from '../layers/smhiWarnings/source.js';
import { createPolisenEventsSource } from '../layers/policeEvents/source.js';
import { createElectricityPricesSource } from '../layers/electricity/source.js';
import { createPowerGridSource } from '../layers/powerGrid/source.js';
import { createTransitAlertsSource } from '../layers/transitAlerts/source.js';
import { createSrTrafficSource } from '../layers/srTraffic/source.js';
import { createSeaWeatherSource } from '../layers/seaWeather/source.js';
import { createLightningStrikesSource } from '../layers/lightningStrikes/source.js';
import { createFireStationsSource } from '../layers/fireStations/source.js';
import { createSpeedCamerasSource } from '../layers/speedCameras/source.js';
import { createRiverFlowSource } from '../layers/riverFlow/source.js';
import { createGammaRadiationSource } from '../layers/gammaRadiation/source.js';
import { createAuroraSource } from '../layers/aurora/source.js';
import { createSmhiWeatherSource } from '../layers/smhiWeather/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    // Canada (ECCC AQHI) and, in the Swedish fork, Sweden (SMHI on the EAQI).
    'air-quality': createCombinedAirQualitySource([
      createEcccAirQualitySource(),
      createSmhiAirQualitySource(),
    ]),
    'fire-perimeters': createWfigsPerimeterSource(),
    'drone-airspace': createDroneAirspaceSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    'trafikverket-roads': createTrafikverketRoadsSource(),
    'trafikverket-weather': createTrafikverketWeatherSource(),
    'smhi-warnings': createSmhiWarningsSource(),
    'polisen-events': createPolisenEventsSource(),
    'electricity-prices': createElectricityPricesSource(),
    'power-grid': createPowerGridSource(),
    'transit-alerts': createTransitAlertsSource(),
    'sr-traffic': createSrTrafficSource(),
    'sea-weather': createSeaWeatherSource(),
    'lightning-strikes': createLightningStrikesSource(),
    'fire-stations': createFireStationsSource(),
    'speed-cameras': createSpeedCamerasSource(),
    'river-flow': createRiverFlowSource(),
    'gamma-radiation': createGammaRadiationSource(),
    aurora: createAuroraSource(),
    'smhi-weather': createSmhiWeatherSource(),
  };
}
