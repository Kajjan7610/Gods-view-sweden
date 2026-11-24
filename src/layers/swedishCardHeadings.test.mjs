// Swedish fork: the Context panel's card for anything a Swedish layer draws,
// or the Swedish part of an original layer draws, is headed by a name a
// person would use (a ferry route, a station, a store, a train, a road
// camera), never by the pick id it was clicked as ("se-ferry:21",
// "rail:trafikverket-trains:2861-20261121", "se-trafikverket-30000123").
// The card finds its heading through the layer's findByQuery and its records
// (src/data/pickedContext.js, src/data/entityContext.js); each layer here
// draws one fixture and every item it draws is clicked as Context clicks it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import {
  railLayerHarness,
  railTrain,
} from '../testSupport/railLayerHarness.mjs';
import { fromDegrees } from '../geo/ellipsoid.js';
import * as picking from '../data/pickRegistry.js';
import { resolvePickedContext } from '../data/pickedContext.js';
import { describeEntity } from '../data/entityContext.js';
import { LAYER_PROVENANCE } from '../ui/layerProvenance.js';
import { createSurfaceServices } from '../app/surfaceServices.js';
import { createApplicationTransit } from '../app/layers/transit.js';
import { createAirQualityLayer } from './airQuality/index.js';
import { normalizeSmhiReadings } from './airQuality/model.js';
import { createCctvLayer, createCctvSource } from './cctv/index.js';
import { createCompanyStoresLayer } from './companyStores/index.js';
import {
  createElectionDistrictsLayer,
  encodeLine,
} from './electionDistricts/index.js';
import { createElectricityPricesLayer } from './electricity/index.js';
import { createFireStationsLayer } from './fireStations/index.js';
import { createFrostDepthLayer } from './frostDepth/index.js';
import { createGammaRadiationLayer } from './gammaRadiation/index.js';
import { createHeritageRemainsLayer } from './heritageRemains/index.js';
import { createHospitalsLayer } from './hospitals/index.js';
import { createLightningStrikesLayer } from './lightningStrikes/index.js';
import { createOutdoorTrailsLayer } from './outdoorTrails/index.js';
import { createPolisenEventsLayer } from './policeEvents/index.js';
import { createPoliceStationsLayer } from './policeStations/index.js';
import { createPopulationGridLayer } from './populationGrid/index.js';
import { createProtectedNatureLayer } from './protectedNature/index.js';
import { createRestAreasLayer } from './restAreas/index.js';
import { createRiverFlowLayer } from './riverFlow/index.js';
import { createRoadFerriesLayer } from './roadFerries/index.js';
import { createRoadQueuesLayer } from './roadQueues/index.js';
import { createTrafikverketWeatherLayer } from './roadWeather/index.js';
import { createSeaWeatherLayer } from './seaWeather/index.js';
import { createSheltersLayer } from './shelters/index.js';
import { createSmhiWeatherLayer } from './smhiWeather/index.js';
import { createSpeedCamerasLayer } from './speedCameras/index.js';
import { createSrTrafficLayer } from './srTraffic/index.js';
import { createTransitAlertsLayer } from './transitAlerts/index.js';
import {
  compactTurbine,
  createWindTurbinesLayer,
  statusCode,
} from './windTurbines/index.js';

const NOW = Date.parse('2026-11-21T12:00:00+01:00');
const MINUTE = 60_000;
/**
 * A heading that is a pick id: lower-case words and numbers joined by
 * colons, hyphens or underscores, with or without a colon
 * ("se-ferry:21", "se-trafikverket-30000123", "trafiklab-sl:9031005").
 */
const RAW_ID = /^[a-z][a-z0-9.,]*(?:[-_:][a-z0-9.,]+)+$/;

/**
 * Swedish layers whose clicks open only their own card on the map: they own
 * no picks, so Context names nothing under them and opens no card.
 */
const NO_CONTEXT_CARD = Object.freeze({
  'trafikverket-roads': 'owns no picks; its own card only',
  'power-grid': 'owns no picks; its own card only',
  'smhi-warnings': 'owns no picks; its own card only',
  municipalities: 'owns no picks; its own card only',
  'historical-ortho': 'imagery, nothing to click',
  aurora: 'a forecast oval, nothing to click',
});

/**
 * Original layers with Swedish data whose items Context names some other
 * way, or that have none to click.
 */
const ADDED_WITHOUT_PICKS = Object.freeze({
  earthquakes: 'named through the context store, not by a pick id',
  'weather-radar': 'imagery, nothing to click',
  'weather-lightning': 'imagery, nothing to click',
});
/** Original layers with Swedish data that own picks: each is checked here. */
const ADDED_WITH_PICKS = Object.freeze([
  'air-quality',
  'cctv',
  'rail',
  'transit',
]);

/** A closed square ring of 0.01°, encoded as the polygon layers keep it. */
const squareOf = (lon, lat) =>
  encodeLine([
    [lon, lat],
    [lon + 0.01, lat],
    [lon + 0.01, lat + 0.01],
    [lon, lat + 0.01],
    [lon, lat],
  ]);

/** A canvas good enough for icons drawn on one: every call is a no-op. */
const fakeDocument = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () =>
      new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) }),
  }),
};

const TRAIL_LINE = [
  [18.25, 59.17],
  [18.28, 59.175],
];

/** An SMHI air quality station that measured an hour ago. */
const SMHI_STATION = normalizeSmhiReadings(
  [
    {
      id: '59.3400,18.0570',
      name: 'Stockholm Hornsgatan',
      lat: 59.34,
      lon: 18.057,
      pollutants: { NO2: { value: 59.3, at: Date.now() - 60 * MINUTE } },
    },
  ],
  Date.now(),
);

/**
 * One fixture per layer: `make` builds it on the common doubles, `source`
 * answers as its own source does, `at` is where the view looks, and
 * `heading` is what the card of its fixture says.
 */
const CASES = [
  {
    id: 'air-quality',
    make: createAirQualityLayer,
    source: { getSnapshot: async () => SMHI_STATION },
    at: [18.057, 59.34],
    heading: 'Stockholm Hornsgatan',
  },
  {
    id: 'road-ferries',
    make: (o) => createRoadFerriesLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        routes: [
          {
            id: '21',
            name: 'Gullmarsleden',
            point: [11.6, 58.32],
            harbors: ['Finnsbo', 'Skår'],
            status: 'running',
            messages: [],
            departures: [
              { at: NOW + 20 * MINUTE, from: 'Finnsbo', to: 'Skår', info: [] },
            ],
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [11.6, 58.32],
    heading: 'Gullmarsleden',
  },
  {
    id: 'police-stations',
    make: createPoliceStationsLayer,
    source: {
      getSnapshot: async () => ({
        stale: false,
        fetchedAt: NOW,
        stations: [
          {
            id: '1233',
            point: [18.07, 59.31],
            name: 'Södermalm',
            address: 'Torkel Knutssonsgatan 20',
            url: 'https://polisen.se/om-polisen/kontakt/polisstationer/stockholms-lan/sodermalm/',
            services: ['report'],
          },
        ],
      }),
    },
    at: [18.07, 59.31],
    heading: 'Södermalm',
  },
  {
    id: 'polisen-events',
    make: (o) => createPolisenEventsLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        events: [
          {
            id: '613207',
            time: NOW - 60 * MINUTE,
            type: 'Trafikolycka',
            category: 'traffic',
            title: '21 november 11.00, Trafikolycka, Göteborg',
            summary: null,
            place: 'Göteborg',
            county: 'Västra Götalands län',
            precision: 'municipality',
            point: [11.9675, 57.7075],
            link: null,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [11.9675, 57.7075],
    heading: 'Trafikolycka · Göteborg',
    // The dot stands near the town's centre: the card's coordinates come
    // with Polisen's own caveat.
    fact: ['Location', 'Polisen gives no exact place'],
  },
  {
    id: 'speed-cameras',
    make: createSpeedCamerasLayer,
    source: {
      getSnapshot: async () => ({
        cameras: [
          {
            id: '4711',
            name: 'Rotebro',
            road: 'E4',
            bearing: 90,
            county: 'Stockholms län',
            point: [17.9, 59.47],
          },
        ],
        stale: false,
        fetchedAt: 0,
      }),
    },
    at: [17.9, 59.47],
    heading: 'E4 · Rotebro',
    // The camera icons are drawn on a canvas.
    document: fakeDocument,
  },
  {
    id: 'trafikverket-weather',
    make: (o) => createTrafikverketWeatherLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '222',
            name: 'Bergsbrunna',
            point: [17.72, 59.84],
            sampled: NOW - 5 * MINUTE,
            surfaceTemp: -0.6,
            airTemp: 0.2,
            dewpoint: -1,
            humidity: 90,
            visibility: null,
            windSpeed: null,
            windDirection: null,
            windGust: null,
            precipitation: 'no',
            precipitation30: null,
            surfaceIce: null,
            surfaceSnow: null,
            surfaceWater: null,
            grip: null,
            risk: null,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [17.72, 59.84],
    heading: 'Bergsbrunna',
  },
  {
    id: 'river-flow',
    make: (o) => createRiverFlowLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '2358',
            name: 'Räktfors',
            river: 'Kalixälven',
            catchmentKm2: 23_600,
            point: [22.83, 66.17],
            flow: 312.5,
            change: 0,
            since: NOW - 105 * MINUTE,
            updated: NOW - 60 * MINUTE,
            quality: 'O',
            owner: 'SMHI',
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [22.83, 66.17],
    heading: 'Räktfors',
  },
  {
    id: 'electricity-prices',
    make: (o) => createElectricityPricesLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        zones: [
          {
            id: 'SE1',
            name: 'Luleå',
            point: [21.0, 66.5],
            today: [
              { start: NOW, end: NOW + 15 * MINUTE, sek: 0.4, eur: 0.04 },
            ],
            tomorrow: [],
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [21.0, 66.5],
    heading: 'Bidding zone SE1',
  },
  {
    id: 'company-stores',
    make: createCompanyStoresLayer,
    source: {
      getSnapshot: async () => ({
        stores: [
          {
            id: 'n42',
            company: 'axfood',
            brand: 'Willys',
            name: 'Sickla',
            point: [18.12, 59.3],
            address: 'Sickla allé 1',
            hours: null,
          },
        ],
        companies: [],
        osmBase: '2026-11-01T00:00:00Z',
        populationYear: 2025,
      }),
    },
    at: [18.12, 59.3],
    heading: 'Willys · Sickla',
  },
  {
    id: 'fire-stations',
    make: createFireStationsLayer,
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '7',
            point: [13.5, 59.38],
            name: 'Karlstad',
            readiness: 'full-time',
            near: null,
          },
        ],
        stale: false,
        fetchedAt: 1,
      }),
    },
    at: [13.5, 59.38],
    heading: 'Karlstad',
  },
  {
    id: 'gamma-radiation',
    make: (o) => createGammaRadiationLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '5',
            name: 'Gävle',
            point: [17.14, 60.67],
            value: 0.121,
            updated: NOW - 60 * MINUTE,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [17.14, 60.67],
    heading: 'Gävle',
  },
  {
    id: 'hospitals',
    make: createHospitalsLayer,
    source: {
      getSnapshot: async () => ({
        hospitals: [
          {
            id: 'w12',
            name: 'Karolinska universitetssjukhuset Solna',
            point: [18.03, 59.35],
            ed: { ttl2025: 40, tvt2025: 320 },
          },
        ],
        statistics: { year: 2025, national: { ttl2025: 61, tvt2025: 256 } },
        osmBase: '2026-11-01T00:00:00Z',
      }),
    },
    at: [18.03, 59.35],
    heading: 'Karolinska universitetssjukhuset Solna',
  },
  {
    id: 'lightning-strikes',
    make: (o) => createLightningStrikesLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        strikes: [
          {
            id: 's1',
            point: [15.5, 58.4],
            at: NOW - 2 * MINUTE,
            kind: 'ground-negative',
            amp: -12.3,
            sensors: 4,
          },
        ],
        stale: false,
        truncated: false,
        fetchedAt: NOW,
      }),
    },
    at: [15.5, 58.4],
    heading: 'LIGHTNING STRIKE',
  },
  {
    id: 'sea-weather',
    make: (o) => createSeaWeatherLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '2507',
            name: 'Göteborg Torshamnen',
            point: [11.79, 57.68],
            level: -18,
            levelReference: 'MVY',
            waterTemp: 10.1,
            waveHeight: null,
            updated: NOW - 60 * MINUTE,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [11.79, 57.68],
    heading: 'Göteborg Torshamnen',
  },
  {
    id: 'shelters',
    make: createSheltersLayer,
    source: {
      getSnapshot: async () => ({
        stale: false,
        fetchedAt: NOW,
        count: 63_364,
        tooWide: false,
        total: 1,
        places: 60,
        shelters: [
          {
            id: '3',
            point: [18.07, 59.33],
            number: '10003-7',
            property: 'Sundin 20',
            places: 60,
            limited: false,
            special: false,
            distance: 0,
          },
        ],
      }),
    },
    at: [18.07, 59.33],
    heading: 'SHELTER · 10003-7',
  },
  {
    id: 'smhi-weather',
    make: (o) => createSmhiWeatherLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: '97400',
            name: 'Stockholm-Arlanda Flygplats',
            point: [17.95, 59.65],
            airTemp: 3.9,
            wind: 4.2,
            gust: 7.1,
            precipitation: 0.2,
            updated: NOW - 30 * MINUTE,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
      getForecast: async () => ({ next24: null, days: [] }),
    },
    at: [17.95, 59.65],
    heading: 'Stockholm-Arlanda Flygplats',
  },
  {
    id: 'sr-traffic',
    make: (o) => createSrTrafficLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        messages: [
          {
            id: '7',
            point: [18.05, 59.35],
            priority: 3,
            category: 'road',
            kind: 'Trafikolycka',
            title: 'E4 Stockholm',
            location: 'Vid Norrtull',
            description: 'Ett körfält avstängt',
            created: NOW - 30 * MINUTE,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [18.05, 59.35],
    heading: 'Trafikolycka · E4 Stockholm',
  },
  {
    id: 'transit-alerts',
    make: (o) => createTransitAlertsLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        stops: [
          {
            id: '9117',
            name: 'Odenplan',
            point: [18.05, 59.34],
            operator: 'sl',
            operatorName: 'SL',
            kind: 'closed',
            alerts: [
              {
                id: '9117-1',
                kind: 'closed',
                header: 'Hållplatsen trafikeras inte',
                description: 'Vägarbete',
                endsAt: null,
              },
            ],
          },
        ],
        pending: [],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [18.05, 59.34],
    heading: 'Odenplan',
  },
  {
    id: 'rest-areas',
    make: (o) => createRestAreasLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        areas: [
          {
            id: '17',
            name: 'Storlien',
            point: [12.1, 63.32],
            status: 'lorry',
            spaces: { car: 20, lorry: 6 },
          },
        ],
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [12.1, 63.32],
    heading: 'Rest area · Storlien',
  },
  {
    id: 'frost-depth',
    make: (o) => createFrostDepthLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        points: [
          {
            id: '5',
            name: 'Bunkris',
            point: [13.5, 61.2],
            sampledAt: NOW - 60 * MINUTE,
            depth: 40,
            frost: { top: 0, bottom: 40 },
          },
        ],
        silent: 0,
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [13.5, 61.2],
    heading: 'Frost depth · Bunkris',
  },
  {
    id: 'road-queues',
    make: (o) => createRoadQueuesLayer({ ...o, now: () => NOW }),
    source: {
      getSnapshot: async () => ({
        routes: [
          {
            id: '101',
            name: 'Essingeleden norrut',
            status: 'congested',
            travelTimeS: 80,
            normalS: 50,
            delayS: 30,
            speedKmh: 31.5,
            lengthM: 700,
            measuredAt: NOW - MINUTE,
            lines: [
              [
                [18.0, 59.32],
                [18.01, 59.325],
                [18.02, 59.33],
              ],
            ],
          },
        ],
        points: [],
      }),
    },
    at: [18.01, 59.325],
    heading: 'Travel time · Essingeleden norrut',
  },
  {
    id: 'outdoor-trails',
    make: createOutdoorTrailsLayer,
    source: {
      getSnapshot: async () => ({
        facilities: [
          {
            id: '11',
            point: [18.27, 59.176],
            name: 'Vindskyddet vid Stensjön',
            type: 'Vindskydd',
            subtype: null,
            kind: 'shelter',
            accessible: false,
            description: null,
            area: 'Tyresta',
            stateTrail: false,
            distance: 50,
          },
        ],
        trails: [
          {
            id: 'l7',
            name: 'Sörmlandsleden',
            type: 'Vandringsled',
            category: null,
            kind: 'hike',
            marking: 'Orange',
            description: null,
            area: 'Tyresta',
            stateTrail: false,
            lengthKm: 12.5,
            anchor: [18.28, 59.175],
            distance: 30,
            lines: [encodeLine(TRAIL_LINE)],
          },
        ],
        facilityTotal: 1,
        trailTotal: 1,
        tooWide: false,
        capped: false,
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [18.27, 59.175],
    heading: 'Facility · Vindskyddet vid Stensjön',
  },
  {
    id: 'wind-turbines',
    make: createWindTurbinesLayer,
    source: {
      getSnapshot: async () => ({
        turbines: [
          compactTurbine({
            id: '2262-V-004-012',
            point: [17.3, 62.4],
            status: statusCode('Uppfört'),
            kind: 'built',
            totalHeightM: 200,
            powerMW: 5.6,
            project: 'Vindpark Exempelberget',
            municipality: 'Timrå',
          }),
        ],
        total: 1,
        builtMW: 5.6,
        counts: { built: 1, planned: 0, rejected: 0 },
        tooWide: false,
        capped: false,
        stale: false,
        fetchedAt: NOW,
        updated: '2026-11-02',
      }),
    },
    at: [17.3, 62.4],
    heading: 'Wind turbine · Vindpark Exempelberget',
  },
  {
    id: 'heritage-remains',
    make: (o) => createHeritageRemainsLayer({ ...o, openExternal: () => {} }),
    source: {
      getSnapshot: async () => ({
        remains: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            point: [16.545, 59.611],
            type: 'Gravfält',
            number: 'L1:1',
            raa: null,
            name: null,
            municipality: 'Västerås',
            assessment: 'fl',
            confirmed: true,
            page: '10000000-0000-4000-8000-000000000001',
            distance: 90,
          },
        ],
        total: 1,
        tooWide: false,
        capped: false,
        stale: false,
        fetchedAt: NOW,
      }),
    },
    at: [16.545, 59.611],
    height: 3000,
    heading: null,
  },
  {
    id: 'election-districts',
    make: createElectionDistrictsLayer,
    source: {
      getDistricts: async () => ({
        districts: [
          {
            c: '01800101',
            n: 'Gamla stan',
            k: '0180',
            m: 'Stockholm',
            b: [18.07, 59.32, 18.08, 59.33],
            g: [[squareOf(18.07, 59.32)]],
            v: 1000,
            s: [300, 250, 200, 50, 50, 50, 50, 40, 10],
            t: 900,
          },
        ],
        capped: false,
        source: 'Valmyndigheten',
        election: 'Riksdag 2026',
        built: '2026-11-12',
      }),
    },
    at: [18.075, 59.325],
    height: 20_000,
    rect: { west: 17.9, south: 59.25, east: 18.2, north: 59.4 },
    heading: 'Gamla stan',
  },
  {
    id: 'protected-nature',
    make: (o) =>
      createProtectedNatureLayer({
        ...o,
        mapStackEventTarget: new EventTarget(),
      }),
    source: {
      getAreas: async () => ({
        areas: [
          {
            i: '2000001',
            n: 'Tyresta',
            t: 'np',
            y: 1993,
            k: 'Haninge',
            h: 1962,
            b: [18.25, 59.18, 18.26, 59.19],
            g: [[squareOf(18.25, 59.18)]],
          },
        ],
        wide: false,
        close: true,
        capped: false,
        source: 'Naturvårdsverket',
        built: '2026-11-12',
      }),
    },
    at: [18.255, 59.185],
    height: 20_000,
    rect: { west: 18.1, south: 59.1, east: 18.4, north: 59.3 },
    heading: 'Tyresta',
  },
  {
    id: 'population-grid',
    make: (o) =>
      createPopulationGridLayer({
        ...o,
        mapStackEventTarget: new EventTarget(),
      }),
    source: {
      getSquares: async () => ({
        squares: [[675, 6575, 2, 4320]],
        level: 25,
        capped: false,
        year: 2025,
        built: '2026-11-19',
      }),
    },
    at: [18.07, 59.33],
    height: 20_000,
    rect: { west: 11, south: 55.5, east: 24, north: 68.5 },
    heading: null,
  },
];

/** The view a layer is shown in: a camera over `at` and the ground there. */
function sceneOver({ at, height = 5000, rect = null }) {
  const [lon, lat] = at;
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon, lat, height, position: fromDegrees(lon, lat, height) },
    viewRectangle: rect ?? {
      west: lon - 0.1,
      south: lat - 0.05,
      east: lon + 0.1,
      north: lat + 0.05,
    },
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => fromDegrees(lon, lat) },
    globe: { isGlobeVisible: () => true },
  });
  return { viewer, draw };
}

/** Context's data manager, with only `layer` in it and on. */
function managerOf(layer) {
  const layers = new Map([[layer.id, { module: layer, enabled: true }]]);
  return {
    layers,
    isEnabled: (id) => layers.has(id),
    getAll: () => [{ id: layer.id, name: layer.name, enabled: true }],
  };
}

/** The heading of the card a Context click on each drawn item opens. */
function headings(layer, draw) {
  const dataManager = managerOf(layer);
  const found = [];
  for (const set of draw.sets.values()) {
    if (set.disposed) continue;
    for (const id of set.items.keys()) {
      if (picking.findPickOwner(id) !== layer.id) continue;
      const identity = resolvePickedContext(
        { set: set.spec.id, id, surface: false },
        { dataManager },
      );
      const card = describeEntity(dataManager, identity);
      found.push({ id, title: card?.title ?? null, card });
    }
  }
  return found;
}

/** The heading of the card Context opens for `id`. */
const headingOf = (dataManager, id) =>
  describeEntity(
    dataManager,
    resolvePickedContext({ set: 'test', id, surface: false }, { dataManager }),
  )?.title;

for (const fixture of CASES) {
  test(`${fixture.id}: a card is headed by a name, never by its pick id`, async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    if (fixture.document) {
      const real = Object.getOwnPropertyDescriptor(globalThis, 'document');
      globalThis.document = fixture.document;
      t.after(() =>
        real
          ? Object.defineProperty(globalThis, 'document', real)
          : delete globalThis.document,
      );
    }
    const { viewer, draw } = sceneOver(fixture);
    const layer = fixture.make({
      source: fixture.source,
      overlayHost: {
        setEntries() {},
        clearSource() {},
        setVisible() {},
        hitTest: () => null,
      },
      input: () => ({ onClick: () => () => {} }),
      picking,
      pointer: { isPointerFree: () => true },
    });
    layer.init(viewer);
    layer.enable();
    await layer.update();
    const found = headings(layer, draw);
    assert.ok(found.length > 0, 'something drawn to click');
    for (const { id, title } of found) {
      assert.ok(title, `${id} has a heading`);
      assert.doesNotMatch(title, RAW_ID, `${id} is headed "${title}"`);
      assert.ok(!title.includes(id), `${id} is headed "${title}"`);
    }
    if (fixture.heading)
      assert.ok(
        found.some(({ title }) => title === fixture.heading),
        `headed "${fixture.heading}": ${found.map(({ title }) => title)}`,
      );
    if (fixture.fact) {
      const [label, value] = fixture.fact;
      for (const { id, card } of found)
        assert.ok(
          card.facts.some(
            (fact) => fact.label === label && fact.value === value,
          ),
          `${id} says ${label}: ${value}`,
        );
    }
    layer.destroy();
  });
}

test('rail: a Swedish train is headed by its number and destination', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const app = railLayerHarness(t, {
    at: { lat: 59.33, lon: 18.07 },
    disruptions: () => ({
      fetchedAt: 0,
      stale: false,
      disruptions: [],
      places: [],
    }),
  });
  const train = (id, extra) =>
    railTrain(id, 59.33, 18.07, {
      label: `Tåg ${extra.routeId}`,
      category: 'regional',
      ...extra,
    });
  app.feeds.set('trafikverket-trains', () => [
    train('2861-20261121', { routeId: '2861', destination: 'Stockholm C' }),
    train('7044-20261121', { routeId: '7044' }),
  ]);
  await app.enable();
  // The harness owns no picks; the layer's own predicate, as it registers it.
  picking.registerPickOwner('rail', (id) => id.startsWith('rail:'));
  t.after(() => picking.unregisterPickOwner('rail'));
  const dataManager = managerOf(app.layer);
  const heading = (id) =>
    describeEntity(
      dataManager,
      resolvePickedContext(
        { set: 'rail', id, surface: false },
        { dataManager },
      ),
    )?.title;
  assert.equal(
    heading('rail:trafikverket-trains:2861-20261121'),
    'Train 2861 to Stockholm C',
  );
  assert.equal(heading('rail:trafikverket-trains:7044-20261121'), 'Train 7044');
});

test('cctv: a Trafikverket road camera is headed by its name', (t) => {
  const noop = () => {};
  const layer = createCctvLayer({
    services: {
      overlays: {
        clearOverlaySource: noop,
        hitTestWorldOverlay: noop,
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
      },
      sprites: {},
      activation: {},
      locations: { CITY_POIS: {} },
      picking,
      terrain: {},
      ground: {},
      mesh: {},
      focus: {},
      render: { releaseContinuousRender: noop },
    },
    source: createCctvSource({ fetchImpl: async () => new Response('{}') }),
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer._setCctvCoverageStateForTest({
    viewer,
    records: [
      {
        camera: {
          id: 'se-trafikverket-30000123',
          name: 'E4 Kista',
          lat: 59.403,
          lon: 17.944,
          headingDeg: 90,
          fovDeg: 60,
        },
      },
    ],
  });
  // The layer owns its cameras' picks once its catalog is in (lifecycle.js).
  picking.registerPickOwner('cctv', (id) => layer.findByQuery(id) !== null);
  t.after(() => picking.unregisterPickOwner('cctv'));
  const dataManager = managerOf(layer);
  // The camera's icon, and a ray of its coverage, name the camera.
  for (const id of [
    'se-trafikverket-30000123',
    'cctv-se-trafikverket-30000123-ray-tl',
  ]) {
    const title = headingOf(dataManager, id);
    assert.equal(title, 'E4 Kista', id);
    assert.doesNotMatch(title, RAW_ID);
  }
});

test('transit: a Swedish bus is headed by its fleet number, not its key', async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const layer = createApplicationTransit({
    surface: createSurfaceServices({
      terrainSource: {
        getHeights: async (chunk) => chunk.map(() => ({ ellipsoid: 20 })),
      },
      signal: lifetime.signal,
      eventTarget: null,
    }),
  });
  // One SL bus in the layer, as a poll leaves it.
  const state = layer._transitStateForTest();
  state._enabled = true;
  const key = 'trafiklab-sl:9031005990000123';
  state._vehicles.set(key, {
    key,
    feedId: 'trafiklab-sl',
    mode: 'bus',
    fetchedAt: Date.now(),
    record: {
      id: '9031005990000123',
      label: '4057',
      routeId: '9011001000400000',
      lat: 59.33,
      lon: 18.07,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });
  // The layer's own ownership, as it registers it on enable (lifecycle.js).
  picking.registerPickOwner('transit', (id) => state._vehicles.has(id));
  t.after(() => picking.unregisterPickOwner('transit'));
  const title = headingOf(managerOf(layer), key);
  assert.equal(title, '4057');
  assert.doesNotMatch(title, RAW_ID);
});

test('a pick id is told from a name, with or without a colon', () => {
  for (const id of [
    'se-ferry:21',
    'se-trafikverket-30000123',
    'rail:trafikverket-trains:2861-20261121',
    'trafiklab-sl:9031005990000123',
    'air-quality:smhi:59.3400,18.0570',
  ])
    assert.match(id, RAW_ID, id);
  for (const name of [
    'Gullmarsleden',
    'E4 · Rotebro',
    'Bidding zone SE1',
    'Train 2861 to Stockholm C',
    '4057',
    'Stockholm-Arlanda Flygplats',
  ])
    assert.doesNotMatch(name, RAW_ID, name);
});

test('every Swedish layer is checked here, or says why Context opens no card', () => {
  const checked = new Set([
    ...CASES.map((fixture) => fixture.id),
    ...Object.keys(NO_CONTEXT_CARD),
  ]);
  const own = Object.entries(LAYER_PROVENANCE)
    .filter(([, entry]) => entry.mark === 'se')
    .map(([id]) => id);
  assert.deepEqual(
    own.filter((id) => !checked.has(id)),
    [],
  );
  // The original's layers with Swedish data: checked, or said why not.
  const added = Object.entries(LAYER_PROVENANCE)
    .filter(([, entry]) => entry.mark === 'plus-se')
    .map(([id]) => id);
  assert.deepEqual(
    added.filter(
      (id) => !ADDED_WITH_PICKS.includes(id) && !(id in ADDED_WITHOUT_PICKS),
    ),
    [],
  );
});
