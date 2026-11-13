import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELECTRICITY_OVERLAY_SOURCE_ID,
  createElectricityPricesLayer,
} from './electricity/index.js';
import {
  FIRE_STATIONS_OVERLAY_SOURCE_ID,
  createFireStationsLayer,
} from './fireStations/index.js';
import {
  GAMMA_RADIATION_OVERLAY_SOURCE_ID,
  createGammaRadiationLayer,
} from './gammaRadiation/index.js';
import {
  LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
  createLightningStrikesLayer,
} from './lightningStrikes/index.js';
import {
  POLICE_OVERLAY_SOURCE_ID,
  createPolisenEventsLayer,
} from './policeEvents/index.js';
import {
  RIVER_FLOW_OVERLAY_SOURCE_ID,
  createRiverFlowLayer,
} from './riverFlow/index.js';
import {
  ROAD_OVERLAY_SOURCE_ID,
  createTrafikverketRoadsLayer,
} from './roadConditions/index.js';
import {
  ROAD_WEATHER_OVERLAY_SOURCE_ID,
  createTrafikverketWeatherLayer,
} from './roadWeather/index.js';
import {
  SEA_WEATHER_OVERLAY_SOURCE_ID,
  createSeaWeatherLayer,
} from './seaWeather/index.js';
import {
  SMHI_WARNINGS_OVERLAY_SOURCE_ID,
  SMHI_WARNINGS_PAGE,
  createSmhiWarningsLayer,
} from './smhiWarnings/index.js';
import {
  SMHI_WEATHER_OVERLAY_SOURCE_ID,
  createSmhiWeatherLayer,
} from './smhiWeather/index.js';
import {
  SPEED_CAMERAS_OVERLAY_SOURCE_ID,
  createSpeedCamerasLayer,
} from './speedCameras/index.js';
import {
  SR_TRAFFIC_OVERLAY_SOURCE_ID,
  createSrTrafficLayer,
} from './srTraffic/index.js';
import {
  TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
  createTransitAlertsLayer,
} from './transitAlerts/index.js';

const NOW = Date.now();
const HOUR = 3_600_000;

/** Two rows a layer can draw: an id, a place, a name and what it adds. */
const pair = (extra, ids = ['1', '2']) =>
  ids.map((id, index) => ({
    id,
    point: [15 + index, 59],
    name: `Row ${id}`,
    ...(typeof extra === 'function' ? extra(id) : extra),
  }));

/** What a test clicks on, and the card it expects, for each of those rows. */
const rows = (pick, card, ids = ['1', '2']) =>
  ids.map((id) => ({ pick: pick + id, card: card + id }));

const POLICE_LINK = (id) => `https://polisen.se/aktuellt/handelser/${id}/`;
const ROAD_LINK = 'https://www.trafikverket.se/trafikinformation/vag/a';
const CRISIS_LINK = 'https://www.krisinformation.se/nyheter/v';
const incident = (id, lon, extra = {}) => ({
  id,
  kind: 'accident',
  severity: 4,
  point: [lon, 60],
  lines: [],
  type: 'Accident',
  ...extra,
});
const crisis = (id, kind, lon, extra = {}) => ({
  id,
  kind,
  point: [lon, 60],
  headline: `Notice ${id}`,
  scope: 'country',
  updated: NOW,
  published: NOW,
  sender: 'Sender',
  ...extra,
});

/**
 * One entry per layer: its factory, the source its card is published under,
 * what its feed answers, and the rows to click. A row with `link` is one
 * whose card opens that page.
 */
const LAYERS = [
  {
    name: 'electricity',
    create: createElectricityPricesLayer,
    sourceId: ELECTRICITY_OVERLAY_SOURCE_ID,
    snapshot: {
      zones: pair(
        {
          today: [{ start: NOW, end: NOW + HOUR, sek: 0.5, eur: 0.05 }],
          tomorrow: [],
        },
        ['SE3', 'SE4'],
      ),
    },
    rows: rows('se-elpris:', 'electricity-card:', ['SE3', 'SE4']),
  },
  {
    name: 'fireStations',
    create: createFireStationsLayer,
    sourceId: FIRE_STATIONS_OVERLAY_SOURCE_ID,
    snapshot: { stations: pair({ readiness: 'full-time' }) },
    rows: rows('se-fire-station:', 'fire-stations-card:'),
  },
  {
    name: 'gammaRadiation',
    create: createGammaRadiationLayer,
    sourceId: GAMMA_RADIATION_OVERLAY_SOURCE_ID,
    snapshot: { stations: pair({ value: 0.1, updated: NOW }) },
    rows: rows('se-gamma:', 'gamma-radiation-card:'),
  },
  {
    name: 'lightningStrikes',
    create: createLightningStrikesLayer,
    sourceId: LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
    snapshot: {
      strikes: pair({
        at: NOW,
        kind: 'ground-negative',
        amp: -12,
        sensors: 5,
      }),
      truncated: false,
    },
    rows: rows('se-lightning:', 'lightning-strikes-card:'),
  },
  {
    name: 'riverFlow',
    create: createRiverFlowLayer,
    sourceId: RIVER_FLOW_OVERLAY_SOURCE_ID,
    snapshot: { stations: pair({ flow: 12, updated: NOW }) },
    rows: rows('se-flow:', 'river-flow-card:'),
  },
  {
    name: 'roadWeather',
    create: createTrafikverketWeatherLayer,
    sourceId: ROAD_WEATHER_OVERLAY_SOURCE_ID,
    snapshot: {
      stations: pair({
        surfaceTemp: 1,
        airTemp: 2,
        sampled: NOW,
        risk: null,
      }),
    },
    rows: rows('se-roadwx:', 'trafikverket-weather-card:'),
  },
  {
    name: 'seaWeather',
    create: createSeaWeatherLayer,
    sourceId: SEA_WEATHER_OVERLAY_SOURCE_ID,
    snapshot: { stations: pair({ meanWind: 5, updated: NOW }) },
    rows: rows('se-sea:', 'sea-weather-card:'),
  },
  {
    name: 'smhiWeather',
    create: createSmhiWeatherLayer,
    sourceId: SMHI_WEATHER_OVERLAY_SOURCE_ID,
    snapshot: { stations: pair({ airTemp: 3, updated: NOW }) },
    // A selected station asks for its forecast.
    source: { getForecast: async () => ({ next24: null, days: [] }) },
    rows: rows('se-smhiobs:', 'smhi-weather-card:'),
  },
  {
    name: 'speedCameras',
    create: createSpeedCamerasLayer,
    sourceId: SPEED_CAMERAS_OVERLAY_SOURCE_ID,
    snapshot: { cameras: pair({ road: 'E4', bearing: 85 }) },
    rows: rows('se-speed-camera:', 'speed-camera-card:'),
  },
  {
    name: 'srTraffic',
    create: createSrTrafficLayer,
    sourceId: SR_TRAFFIC_OVERLAY_SOURCE_ID,
    snapshot: {
      messages: pair({
        title: 'Rv 62 Deje-Forshaga',
        kind: 'Roadworks',
        priority: 3,
        category: 'road',
        created: NOW,
        description: 'Road closed',
        location: 'Deje',
      }),
    },
    rows: rows('se-srtrafik:', 'sr-traffic-card:'),
  },
  {
    name: 'transitAlerts',
    create: createTransitAlertsLayer,
    sourceId: TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
    snapshot: {
      stops: pair({
        kind: 'closed',
        operatorName: 'Operator',
        alerts: [
          {
            id: 'a',
            kind: 'closed',
            header: 'Stop closed',
            description: 'No buses stop here.',
            endsAt: NOW + HOUR,
          },
        ],
      }),
      pending: [],
    },
    rows: rows('se-trafikstorning:', 'transit-alerts-card:'),
  },
  {
    name: 'policeEvents',
    create: createPolisenEventsLayer,
    sourceId: POLICE_OVERLAY_SOURCE_ID,
    linked: true,
    snapshot: {
      events: pair((id) => ({
        time: NOW - 60_000,
        type: 'Trafikolycka',
        category: 'traffic',
        place: 'Falun',
        precision: 'municipality',
        summary: 'Two cars.',
        link: POLICE_LINK(id),
      })),
    },
    rows: rows('se-polisen:', 'polisen-card:').map((row, index) => ({
      ...row,
      link: POLICE_LINK(index + 1),
    })),
  },
  {
    name: 'roadConditions',
    create: createTrafikverketRoadsLayer,
    sourceId: ROAD_OVERLAY_SOURCE_ID,
    linked: true,
    snapshot: {
      conditions: [
        {
          id: 'k',
          code: 3,
          text: 'Slippery',
          lines: [
            [
              [15, 60],
              [15.1, 60.1],
            ],
          ],
          info: [],
          warnings: [],
          measures: [],
        },
      ],
      incidents: [incident('a', 16, { link: ROAD_LINK }), incident('b', 17)],
    },
    // An incident with a page, one without, and a stretch of road.
    rows: [
      {
        pick: 'se-road:i:a:point',
        card: 'trafikverket-road-card:i:a',
        link: ROAD_LINK,
      },
      { pick: 'se-road:i:b:point', card: 'trafikverket-road-card:i:b' },
      { pick: 'se-road:c:k:0', card: 'trafikverket-road-card:c:k' },
    ],
  },
  {
    name: 'smhiWarnings',
    create: createSmhiWarningsLayer,
    sourceId: SMHI_WARNINGS_OVERLAY_SOURCE_ID,
    linked: true,
    snapshot: {
      areas: [
        {
          id: '1:2',
          level: 'YELLOW',
          upcoming: false,
          polygons: [
            {
              outer: [
                [18, 67],
                [19, 67],
                [19, 68],
                [18, 67],
              ],
              holes: [],
            },
          ],
          counties: [],
          texts: [],
          event: { sv: 'Vind', en: 'Wind' },
          start: NOW,
          end: NOW + HOUR,
          published: NOW,
        },
      ],
      crisis: [
        crisis('v', 'vma', 16, { link: CRISIS_LINK }),
        crisis('n', 'news', 17),
      ],
    },
    // A warning area opens the warnings page, a notice its own page.
    rows: [
      {
        pick: 'se-smhiwarn:1:2:fill0',
        card: 'smhi-warning-card:1:2',
        link: SMHI_WARNINGS_PAGE,
      },
      {
        pick: 'se-krisinfo:v',
        card: 'krisinformation-card:v',
        link: CRISIS_LINK,
      },
      { pick: 'se-krisinfo:n', card: 'krisinformation-card:n' },
    ],
  },
];

/** A viewer, as far as a layer looks at one. */
function fakeViewer() {
  const sources = [];
  const viewer = {
    sources,
    picked: undefined,
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
    scene: {
      pick: () => viewer.picked,
      requestRender() {},
    },
  };
  return viewer;
}

/**
 * The layer, enabled and drawn, with a click handler a test can drive and a
 * host that keeps what each source published. `cards` reads the card source
 * only: value labels go to a source of their own.
 */
async function harness(spec, options = {}) {
  const viewer = fakeViewer();
  const entries = new Map();
  const state = {
    cards: () => entries.get(spec.sourceId) ?? [],
    cardIds: () => state.cards().map((card) => card.id),
    cardHit: null,
    click: null,
    opened: [],
  };
  const layer = spec.create({
    source: {
      getSnapshot: async () => ({
        stale: false,
        fetchedAt: NOW,
        ...spec.snapshot,
      }),
      ...spec.source,
    },
    overlayHost: {
      setEntries: (sourceId, list) => entries.set(sourceId, list),
      clearSource: (sourceId) => entries.delete(sourceId),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (state.click = callback),
      destroy: () => (state.click = null),
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    // Only the layers whose cards open a page take this.
    ...(spec.linked ? { openExternal: (url) => state.opened.push(url) } : {}),
    ...options,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  return { layer, viewer, state };
}

const CLICK = { position: { x: 10, y: 20 } };
const OTHER_CARD =
  "a click on another layer's card is not a click on the ground";

/**
 * Select every row in turn, click its card with another row under it, then
 * click the ground. `opens` says whether the layer was given a way to open
 * pages.
 */
async function clickOwnCards(spec, options, opens) {
  const { layer, viewer, state } = await harness(spec, options);
  spec.rows.forEach((row, index) => {
    const link = opens ? row.link : undefined;
    viewer.picked = { id: row.pick };
    state.click(CLICK);
    assert.deepEqual(state.cardIds(), [row.card], row.pick);
    const [card] = state.cards();
    assert.equal(card.interactive, true, row.pick);
    assert.equal(typeof card.activate, link ? 'function' : 'undefined');

    // On the card: the row under the card is not picked.
    viewer.picked = { id: spec.rows[(index + 1) % spec.rows.length].pick };
    state.cardHit = { sourceId: spec.sourceId, entryId: card.id };
    state.click(CLICK);
    assert.deepEqual(state.cardIds(), [row.card], 'the selection stays');
    assert.deepEqual(state.opened.splice(0), link ? [link] : [], row.pick);

    state.cardHit = null;
    viewer.picked = undefined;
    state.click(CLICK);
    assert.deepEqual(state.cardIds(), [], 'a click on the ground lets go');
  });
  layer.destroy();
}

for (const spec of LAYERS) {
  const { name } = spec;

  test(`${name}: a click on its own card keeps the selection`, () =>
    clickOwnCards(spec, {}, true));

  if (spec.linked) {
    test(`${name}: without a way to open pages its card is still hit`, () =>
      clickOwnCards(spec, { openExternal: null }, false));
  }

  test(`${name}: ${OTHER_CARD}`, async () => {
    const { layer, viewer, state } = await harness(spec);
    const [first, second] = spec.rows;
    viewer.picked = { id: first.pick };
    state.click(CLICK);
    assert.deepEqual(state.cardIds(), [first.card]);

    state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
    viewer.picked = undefined;
    state.click(CLICK);
    assert.deepEqual(state.cardIds(), [first.card], 'still selected');
    viewer.picked = { id: second.pick };
    state.click(CLICK);
    assert.deepEqual(
      state.cardIds(),
      [first.card],
      'the row behind the card is not selected',
    );
    assert.deepEqual(state.opened, []);
    layer.destroy();
  });
}
