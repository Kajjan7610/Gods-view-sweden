import { resolveCatalogSources } from './sourceComposition.js';
import { createWeatherClock } from '../layers/weather/clock.js';
import { worldClock } from '../time/worldClock.js';
import { createWeatherLayer } from '../layers/weather/index.js';
import { createApplicationCyclones } from './layers/cyclones.js';
import { createWindLayer } from '../layers/wind/index.js';
import { createLayerCatalog } from './catalog.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createApplicationFlights } from './layers/flights.js';
import { createApplicationMilitary } from './layers/militaryFlights.js';
import { createApplicationVessels } from './layers/aisLiveVessels.js';
import { createApplicationCctv } from './layers/cctv.js';
import { createApplicationRadio } from './layers/radio.js';
import { createApplicationTraffic } from './layers/traffic.js';
import { createApplicationBikeshare } from './layers/bikeshare.js';
import { createApplicationDirections } from './layers/directions.js';
import { createApplicationRecentImagery } from './layers/recentImagery.js';
import { createApplicationOsmPlaces } from './layers/osmPlaces.js';
import { createApplicationTransit } from './layers/transit.js';
import { createApplicationInstallations } from './layers/militaryInstallations.js';
import { createApplicationSatellites } from './layers/satellites.js';
import { createApplicationLaunches } from './layers/rocketLaunches.js';
import { createApplicationAlpr } from './layers/alprCameras.js';
import { createApplicationLocalAdsb } from './layers/localAdsb.js';
import { createApplicationAwareness } from './layers/militaryAwareness.js';
import { createApplicationFirms } from './layers/firms.js';
import { createApplicationEarthquakes } from './layers/earthquakes.js';
import { createApplicationAirQuality } from './layers/airQuality.js';
import { createApplicationFirePerimeters } from './layers/perimeters.js';
import { createApplicationGnssIntegrity } from './layers/gnss.js';
import { createApplicationTrafikverketRoads } from './layers/trafikverketRoads.js';
import { createApplicationTrafikverketWeather } from './layers/trafikverketWeather.js';
import { createApplicationSmhiWarnings } from './layers/smhiWarnings.js';
import { createApplicationPolisenEvents } from './layers/polisenEvents.js';
import { createApplicationElectricityPrices } from './layers/electricityPrices.js';
import { createApplicationPowerGrid } from './layers/powerGrid.js';
import { createApplicationTransitAlerts } from './layers/transitAlerts.js';
import { createApplicationSrTraffic } from './layers/srTraffic.js';
import { createApplicationSeaWeather } from './layers/seaWeather.js';
import { createApplicationCompanyStores } from './layers/companyStores.js';
import { createApplicationLightningStrikes } from './layers/lightningStrikes.js';
import { createApplicationFireStations } from './layers/fireStations.js';
import { createApplicationPoliceStations } from './layers/policeStations.js';
import { createApplicationShelters } from './layers/shelters.js';
import { createApplicationHospitals } from './layers/hospitals.js';
import { createApplicationSpeedCameras } from './layers/speedCameras.js';
import { createApplicationRiverFlow } from './layers/riverFlow.js';
import { createApplicationGammaRadiation } from './layers/gammaRadiation.js';
import { createApplicationAurora } from './layers/aurora.js';
import { createApplicationSmhiWeather } from './layers/smhiWeather.js';
import { createApplicationGhostMaps } from './layers/ghostMaps.js';
import { createApplicationDroneAirspace } from './layers/droneAirspace.js';
import { createApplicationWildlifeSightings } from './layers/wildlifeSightings.js';
import { createApplicationCables } from './layers/submarineCables.js';
import { createOsmOverlayLayers } from '../data/osmOverlays.js';
import { createApplicationStreetLevel } from './layers/streetLevel.js';
import { createInfrastructureLayers } from '../data/infrastructure.js';
import { localGeoJsonServices } from './localGeojsonServices.js';
import { createBhoteKoshiEventLayer } from '../data/bhoteKoshiEvent.js';
import { createBhoteKoshiLocatorLayer } from '../data/bhoteKoshiLocator.js';

/**
 * Hardware-local layers are registered like any other but never enter share
 * links or stored layer state: another browser cannot have this receiver.
 */
export const LOCAL_ONLY_LAYER_METADATA = Object.freeze([
  Object.freeze({ id: 'local-adsb', disposition: 'local-only' }),
  // Voice search results belong to this session, like a receiver to this machine.
  Object.freeze({ id: 'osm-places', disposition: 'local-only' }),
]);

/** Serialization metadata for every layer the application catalog constructs. */
export const APPLICATION_LAYER_METADATA = Object.freeze([
  ...LAYER_STATE_REGISTRY,
  ...LOCAL_ONLY_LAYER_METADATA,
]);

/** Construct the current catalog without choosing any source provider.
 * Scene engines remain page-owned; layers and classification have this app's lifetime.
 * The manager owns layer destruction, while abort releases classification even if startup fails.
 */
export function createApplicationCatalog({
  surface,
  sources,
  signal,
  metadata = APPLICATION_LAYER_METADATA,
  vesselOptions,
  resolveAsset,
  nepalBoundaryResolver,
  streetLevelProviders,
}) {
  if (!signal?.addEventListener)
    throw new TypeError('An application lifetime signal is required');
  signal.throwIfAborted();
  if (!surface?.groundFloor || !surface?.terrain)
    throw new TypeError('Application surface services are required');

  const sourceComposition = resolveCatalogSources(sources);
  sources = sourceComposition.sources;
  const militaryRegistry = createMilitaryRegistry();
  const weatherClock = createWeatherClock({ world: worldClock });
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    militaryRegistry.dispose();
    weatherClock.destroy();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (sourceComposition.isConfigured('military'))
      militaryRegistry.configureSource(sources.military, { signal });
    const flights = createApplicationFlights({
      surface,
      source: sources.flights,
      militaryRegistry,
      resolveAsset,
    });
    const military = createApplicationMilitary({
      surface,
      source: sources.military,
      militaryRegistry,
      resolveAsset,
    });
    const vessels = createApplicationVessels({
      source: sources.vessels,
      options: vesselOptions,
    });
    const installations = createApplicationInstallations({
      surface,
      source: sources.installations,
    });
    const satellites = createApplicationSatellites({
      source: sources.satellites,
    });
    const catalog = createLayerCatalog(
      [
        createBhoteKoshiEventLayer(),
        createBhoteKoshiLocatorLayer({
          boundaryResolver: nepalBoundaryResolver,
        }),
        flights,
        military,
        createApplicationLocalAdsb({
          surface,
          enrichment: sources.flights,
          displayParams: () => flights.getParams(),
          ...(resolveAsset ? { resolveAsset } : {}),
        }),
        createApplicationEarthquakes({ source: sources.earthquakes }),
        createApplicationAirQuality({ source: sources['air-quality'] }),
        createApplicationFirePerimeters({
          source: sources['fire-perimeters'],
        }),
        createApplicationGnssIntegrity({
          source: sources['gnss-integrity'],
          windowMs: sources['gnss-integrity'].windowMs,
        }),
        createApplicationTrafikverketRoads({
          source: sources['trafikverket-roads'],
          terrain: surface.terrain,
        }),
        createApplicationTrafikverketWeather({
          source: sources['trafikverket-weather'],
          terrain: surface.terrain,
        }),
        createApplicationSmhiWarnings({
          source: sources['smhi-warnings'],
          terrain: surface.terrain,
        }),
        createApplicationPolisenEvents({
          source: sources['polisen-events'],
          terrain: surface.terrain,
        }),
        createApplicationElectricityPrices({
          source: sources['electricity-prices'],
          terrain: surface.terrain,
        }),
        createApplicationPowerGrid({
          source: sources['power-grid'],
          terrain: surface.terrain,
        }),
        createApplicationSrTraffic({
          source: sources['sr-traffic'],
          terrain: surface.terrain,
        }),
        createApplicationTransitAlerts({
          source: sources['transit-alerts'],
          terrain: surface.terrain,
        }),
        createApplicationSeaWeather({
          source: sources['sea-weather'],
          terrain: surface.terrain,
        }),
        createApplicationPoliceStations({
          source: sources['police-stations'],
          terrain: surface.terrain,
        }),
        createApplicationShelters({
          source: sources['shelters'],
          terrain: surface.terrain,
        }),
        createApplicationHospitals({
          source: sources['hospitals'],
        }),
        createApplicationCompanyStores({
          source: sources['company-stores'],
        }),
        createApplicationLightningStrikes({
          source: sources['lightning-strikes'],
        }),
        createApplicationFireStations({
          source: sources['fire-stations'],
          terrain: surface.terrain,
        }),
        createApplicationSpeedCameras({
          source: sources['speed-cameras'],
          terrain: surface.terrain,
        }),
        createApplicationRiverFlow({
          source: sources['river-flow'],
          terrain: surface.terrain,
        }),
        createApplicationGammaRadiation({
          source: sources['gamma-radiation'],
          terrain: surface.terrain,
        }),
        createApplicationAurora({
          source: sources.aurora,
        }),
        createApplicationSmhiWeather({
          source: sources['smhi-weather'],
          terrain: surface.terrain,
        }),
        createApplicationGhostMaps({ source: sources['s2-ghostmaps'] }),
        createApplicationDroneAirspace({
          source: sources['drone-airspace'],
        }),
        createApplicationWildlifeSightings({
          source: sources['wildlife-sightings'],
          groundFloor: surface.groundFloor,
        }),
        createApplicationAlpr({ surface, source: sources.alpr }),
        createApplicationStreetLevel({
          surface,
          sources: { mapillary: sources.mapillary },
          providers: streetLevelProviders,
        }),
        satellites,
        createApplicationLaunches({ source: sources.launches, satellites }),
        createApplicationTraffic({ source: sources.traffic, surface }),
        createApplicationCctv({ surface, source: sources.cctv }),
        createApplicationRadio({ surface, source: sources.radio }),
        createApplicationTransit({ surface, source: sources.transit }),
        createApplicationBikeshare({ source: sources.bikeshare }),
        createApplicationDirections({ source: sources.directions }),
        createApplicationRecentImagery({ source: sources['recent-imagery'] }),
        createApplicationOsmPlaces(),
        vessels,
        installations,
        createApplicationAwareness({
          flights,
          military,
          vessels,
          installations,
        }),
        createWindLayer({ feed: sources.wind, clock: weatherClock }),
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-radar',
          // Swedish fork: open on SMHI's Nordic composite.
          radarProduct: 'radar-nordic',
          clock: weatherClock,
        }),
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-satellite',
          clock: weatherClock,
        }),
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-lightning',
          // Swedish fork: open on EUMETSAT's lightning over Europe.
          lightningProduct: 'lightning-europe',
          clock: weatherClock,
        }),
        createApplicationCyclones({ feed: sources.cyclones }),
        ...createOsmOverlayLayers(),
        ...createInfrastructureLayers(localGeoJsonServices),
        createApplicationCables({ source: sources.cables }),
        createApplicationFirms({
          surface,
          id: 'local-firms',
          name: 'FIRMS Active Fires',
          icon: '▲',
          source: 'NASA FIRMS · LIVE',
          feed: sources.firms,
        }),
      ],
      metadata,
    );
    return Object.freeze({
      ...catalog,
      getSourceAvailability: sourceComposition.createAvailabilityLookup(
        catalog.layers,
      ),
      militaryRegistry,
      surface,
      weatherClock,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
