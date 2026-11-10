/**
 * The city dossier: when the view settles low over a Swedish town, the right
 * rail's CITY panel presents that town — its introduction and photo, its
 * population and trend, its municipality's key figures and election, and
 * what is happening there now (weather, warnings, air, police, sun, local
 * radio). Facts come from /api/city-dossier; the live part reuses the
 * briefing, air quality and police routes the layers already use.
 */
import * as Cesium from 'cesium';
import {
  formatNumber,
  getLocale,
  msg,
  onLocaleChange,
  t,
  tn,
} from '../i18n/index.js';
import { normalizeSmhiReadings } from '../layers/airQuality/model.js';
import { weatherCodeLabel } from '../data/regionalModel.js';
import {
  electionYear,
  nearestReading,
  policeEventsFor,
  pollUntil,
  populationChange,
  sparklinePoints,
  sunTimes,
} from './cityDossierModel.js';
import {
  MUNICIPALITY_COUNT,
  challengeProgress,
  loadPassport,
  mostVisited,
  savePassport,
  stampVisit,
  stampsInOrder,
  totalVisits,
} from './visitPassport.js';
import { OrbitController } from '../orbit.js';
import { messagesFor } from './krisinformationModel.js';
import { SIGHT_COLORS, createSightsLayer } from './citySights.js';
import { facingText } from '../layers/speedCameras/cards.js';
import { redrawEntities } from '../layers/redrawEntities.js';

const PANEL_ID = 'city-panel';
/** Higher than this the view is looking at a region, not visiting a town. */
const MAX_VISIT_HEIGHT_M = 80_000;
const SETTLE_DELAY_MS = 500;
const LIVE_TTL_MS = 10 * 60_000;
/** After a part gave no answer the live picture may be asked for again. */
const LIVE_RETRY_MS = 60_000;
/** The live picture's parts, as the "no answer" note names them. */
const LIVE_PARTS = Object.freeze([
  ['brief', msg('Weather now')],
  ['air', msg('Air quality')],
  ['police', null, 'Polisen'], // i18n-ignore: provider name
  ['transit', msg('Traffic')],
  ['aurora', msg('Aurora Forecast')],
  ['cameras', msg('Speed cameras')],
  ['kris', msg('Crisis information')],
]);
const SWEDEN = Object.freeze({
  west: 10.5,
  south: 55,
  east: 24.3,
  north: 69.1,
});
const TABS = Object.freeze([
  ['about', msg('ABOUT')],
  ['people', msg('POPULATION')],
  ['society', msg('SOCIETY')],
  ['now', msg('NOW')],
  ['sights', msg('SIGHTS')],
  ['pass', msg('PASSPORT')],
]);
const CHALLENGE_LABELS = Object.freeze({
  seats: msg('All 21 county seats'),
  counties: msg('A town in every county'),
  arctic: msg('Three towns north of the Arctic Circle'),
  all: msg('Every municipality in Sweden'),
});
/** A first visit circles the town once, unless something interrupts. */
const ARRIVAL_ORBIT_S = 30;
/** The glide to the circle's first position, and the circle's tilt. */
const ARRIVAL_FLY_S = 1.5;
const ARRIVAL_PITCH_DEG = -32;
/** How long the title card and its offer stay. */
const ARRIVAL_TITLE_MS = 12_000;
/** The start view (or a shared link) is a visit too, but not an arrival. */
const STARTUP_QUIET_MS = 20_000;
const STAMP_COLOR = '#ffc94d';
const PARTY_COLORS = Object.freeze({
  S: '#ed1b34',
  V: '#af0000',
  MP: '#83cf39',
  SD: '#dddd00',
  M: '#52bdec',
  L: '#006ab3',
  C: '#009933',
  KD: '#231977',
  other: '#9e9e9e',
});
const ALERT_LEVEL_KEYS = Object.freeze({
  VMA: msg('PUBLIC ALERT'),
  MESSAGE: msg('Message'),
  YELLOW: msg('Yellow warning'),
  ORANGE: msg('Orange warning'),
  RED: msg('Red warning'),
});
const SEK = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const SIGHT_KINDS = Object.freeze({
  castle: msg('Castle or palace'),
  fortress: msg('Fortress'),
  church: msg('Church'),
  museum: msg('Museum'),
  runestone: msg('Runestone'),
  ancient: msg('Ancient monument'),
  manor: msg('Manor'),
  monument: msg('Monument'),
  nature: msg('Nature'),
  lighthouse: msg('Lighthouse'),
});
/** A chosen sight is shown from this far south and this high. */
const SIGHT_VIEW_SOUTH_DEG = 0.011;
const SIGHT_VIEW_HEIGHT_M = 900;
/** A speed camera is looked at from closer and lower than a sight. */
const CAMERA_VIEW_SOUTH_DEG = 0.006;
const CAMERA_VIEW_HEIGHT_M = 500;
/** The proxy gives Trafikverket 30 seconds for the sites; a little more. */
const CAMERA_CARD_WAIT_MS = 35_000;
const AURORA_CHANCES = Object.freeze({
  low: msg('low'),
  possible: msg('possible'),
  good: msg('good'),
  high: msg('high'),
});

const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
/** The Swedish calendar day of a moment, for telling today from tomorrow. */
const day = (ms) =>
  new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const whole = (value) => formatNumber(Math.round(value));
const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const bilingual = (value) =>
  !value || typeof value === 'string'
    ? value || ''
    : String(getLocale() || '').startsWith('sv')
      ? value.sv
      : value.en;

/**
 * Own the dossier for one viewer: watch the camera settle, fetch the town
 * and its live picture, and publish the panel's view.
 */
export function createCityDossier({
  viewer,
  dataManager,
  publish,
  connect,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  // Scenes and other camera owners: no arrival orbit while they hold it.
  isCameraBusy = () => false,
  // The world-overlay host, for the sights' names on the map (optional).
  overlayHost = null,
  // Whether the CITY panel shows its contents: the live picture is fetched
  // only while it does. `watchPanel` tells when that changes, and gives a
  // function that stops telling (null while there is no panel to watch).
  isPanelOpen = () => panelIsOpen(documentRef),
  watchPanel = (onChange) => watchPanelClass(documentRef, onChange),
  // Seams for tests: the sight markers and the fly-in's circle.
  createSights = createSightsLayer,
  createOrbit = (forViewer) => new OrbitController(forViewer),
}) {
  let destroyed = false;
  const createdAt = now();
  const passport = loadPassport(storage);
  let arrival = null;
  /** The town the title card offers the flight in to. */
  let arrivalTown = null;
  let arrivalTimer = null;
  let orbit = null;
  let orbitWatch = null;
  let journey = null;
  let timer = null;
  let request = null;
  let liveRequest = null;
  let city = null;
  let facts = null;
  let live = null;
  let liveAt = 0;
  let tab = 'about';
  let status = 'idle';
  let radioBusy = false;
  let appeared = false;
  /** The town's sights: `{ code, status, items }`, and the one chosen. */
  let sights = null;
  let chosenSight = null;
  let sightsRequest = null;
  const sightsLayer = createSights({
    viewer,
    overlayHost,
    onPick: (id) => chooseSight(id),
  });

  function viewCenter() {
    const canvas = viewer.scene.canvas;
    const height = viewer.camera.positionCartographic?.height;
    if (!Number.isFinite(height) || height > MAX_VISIT_HEIGHT_M) return null;
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    if (!hit) return null;
    const carto = Cesium.Cartographic.fromCartesian(hit);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    if (
      lon < SWEDEN.west ||
      lon > SWEDEN.east ||
      lat < SWEDEN.south ||
      lat > SWEDEN.north
    )
      return null;
    return { lat, lon };
  }

  async function getJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** The live picture is fetched only for someone looking at it. */
  const wantsLive = () => tab === 'now' && isPanelOpen();
  const liveIsDue = () => wantsLive() && now() - liveAt > LIVE_TTL_MS;

  /** The panel opening on the NOW tab is someone starting to look. */
  let stopWatchingPanel = null;
  function watchPanelOnce() {
    stopWatchingPanel ??= watchPanel(() => {
      if (!destroyed && city && liveIsDue()) void loadLive();
    });
  }

  async function visit() {
    timer = null;
    watchPanelOnce();
    if (destroyed || documentRef?.body?.classList?.contains('cockpit-mode'))
      return;
    // A chosen sight may lie over the border: the town stays while it shows.
    if (tab === 'sights' && chosenSight) return;
    const center = viewCenter();
    if (!center) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const body = await getJson(
        `/api/city-dossier?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}`,
        controller.signal,
      );
      if (destroyed || request !== controller || !body?.city) return;
      if (body.city.code !== city?.code) {
        city = body.city;
        facts = body.error ? null : body;
        status = body.error ? 'error' : 'ready';
        live = null;
        liveAt = 0;
        // The start view (or a shared link) is shown, not travelled to: no
        // stamp and no arrival while the page is still starting.
        if (now() - createdAt >= STARTUP_QUIET_MS) {
          const firstVisit = stampVisit(passport, city, now());
          savePassport(storage, passport);
          renderJourney();
          if (firstVisit && passport.cinematic) arrive(city, facts);
        }
        render();
        openOnFirstVisit();
        // A new town on the SIGHTS tab: its own sights, the last town's gone.
        drawSights();
        if (tab === 'sights') void loadSights();
      }
      if (liveIsDue()) void loadLive();
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn('[CityDossier] lookup failed:', error?.message || error);
    } finally {
      if (request === controller) request = null;
    }
  }

  async function loadLive() {
    if (!city) return;
    liveRequest?.abort();
    const controller = new AbortController();
    liveRequest = controller;
    const forCity = city;
    const [lon, lat] = forCity.point;
    liveAt = now();
    // Each part shows as soon as it answers: the briefing (weather and
    // warnings) also gathers news and can take seconds.
    live = {
      brief: null,
      air: null,
      police: null,
      transit: null,
      kris: null,
      aurora: null,
      cameras: null,
      pending: 7,
      failed: [],
    };
    render();
    const current = () =>
      !destroyed && liveRequest === controller && city === forCity;
    const part = (url, field, shape = (value) => value) =>
      getJson(url, controller.signal)
        .then((value) => {
          if (current()) live[field] = shape(value);
        })
        .catch((error) => {
          // Named below what did arrive; a part cut short by a newer load
          // is not one.
          if (current() && error?.name !== 'AbortError')
            live.failed.push(field);
        })
        .finally(() => {
          if (!current()) return;
          live.pending -= 1;
          render();
        });
    await Promise.all([
      part(`/api/regional-brief?latitude=${lat}&longitude=${lon}`, 'brief'),
      part('/api/air-quality-se', 'air', (value) =>
        nearestReading(
          normalizeSmhiReadings(value?.stations, now()),
          forCity.point,
        ),
      ),
      part('/api/polisen-events', 'police', (value) =>
        policeEventsFor(value?.events, forCity, now()),
      ),
      part(
        `/api/city-transit?lat=${lat}&lon=${lon}&town=${encodeURIComponent(forCity.name)}`,
        'transit',
      ),
      // Tonight's northern lights: NOAA's Kp and SMHI's clouds for the town.
      part(`/api/aurora-outlook?lat=${lat}&lon=${lon}`, 'aurora'),
      // Trafikverket's speed camera sites around the town.
      part(`/api/speed-cameras?lat=${lat}&lon=${lon}`, 'cameras'),
      // Krisinformation.se: alerts and news for the country, county or town.
      part('/api/krisinformation', 'kris', (value) =>
        messagesFor(value, {
          municipality: forCity.municipality,
          county: forCity.county,
        }),
      ),
    ]);
    if (current()) {
      liveRequest = null;
      // A part without an answer is worth asking for again soon.
      if (live.failed.length) liveAt = now() - LIVE_TTL_MS + LIVE_RETRY_MS;
    }
  }

  // ---- arrival and passport ------------------------------------------------
  /**
   * A first visit's title card. Nothing moves by itself: the card offers the
   * flight in, and flyIn() makes it when the offer is taken.
   */
  function arrive(town, townFacts) {
    if (
      isCameraBusy() ||
      documentRef?.body?.classList?.contains('cockpit-mode')
    )
      return;
    const town$ = townFacts?.town;
    arrivalTown = town;
    arrival = {
      key: `${town.code}:${now()}`,
      name: town.name,
      line: [
        Number.isFinite(town$?.population)
          ? t('{count} inhabitants', { count: whole(town$.population) })
          : null,
        Number.isFinite(town$?.founded)
          ? t('founded {year}', { year: town$.founded })
          : null,
        town.county,
      ]
        .filter(Boolean)
        .join(' · '),
      // The button under the name, until it is pressed.
      offer: true,
    };
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => {
      arrival = null;
      arrivalTown = null;
      render();
    }, ARRIVAL_TITLE_MS);
  }

  /** Unfold the CITY panel if it is folded. */
  function openPanel() {
    const panel = documentRef?.getElementById?.(PANEL_ID);
    if (panel?.classList?.contains('collapsed'))
      panel.querySelector?.(`[data-collapse-target="${PANEL_ID}"]`)?.click();
  }

  /**
   * The offer taken: one glide to where the slow circle round the town
   * begins, then the circle, with the town's panel open beside it.
   */
  function flyIn() {
    const town = arrivalTown;
    if (
      !town ||
      isCameraBusy() ||
      documentRef?.body?.classList?.contains('cockpit-mode')
    )
      return;
    const [lon, lat] = town.point;
    const target = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const distance = Cesium.Cartesian3.distance(
      viewer.camera.positionWC,
      target,
    );
    stopOrbit();
    const controller = createOrbit(viewer);
    orbit = controller;
    const radius = Math.min(12_000, Math.max(2_500, distance));
    // Any input, a camera owner taking over or one full turn ends it.
    const interrupt = () => stopOrbit();
    for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart'])
      documentRef?.addEventListener?.(type, interrupt, {
        capture: true,
        once: true,
      });
    controller.interrupt = interrupt;
    const circle = () => {
      // Interrupted while gliding in: no circle.
      if (orbit !== controller) return;
      controller.gliding = false;
      controller.start(target, {
        radius,
        pitch: ARRIVAL_PITCH_DEG,
        speed: 360 / ARRIVAL_ORBIT_S,
      });
      const started = now();
      orbitWatch = setInterval(() => {
        if (
          now() - started > ARRIVAL_ORBIT_S * 1000 ||
          isCameraBusy() ||
          documentRef?.body?.classList?.contains('cockpit-mode') ||
          // A flight someone else started (search, voice, a link) wins.
          viewer.camera._currentFlight
        )
          stopOrbit();
      }, 100);
    };
    // To the circle's first position in one glide, from where the camera is
    // and on its own heading; the circle takes over where the glide ends.
    controller.gliding = true;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), {
      offset: new Cesium.HeadingPitchRange(
        viewer.camera.heading,
        Cesium.Math.toRadians(ARRIVAL_PITCH_DEG),
        radius,
      ),
      duration: ARRIVAL_FLY_S,
      complete: circle,
      // Another flight took the camera: it is theirs, and left alone.
      cancel: () => {
        controller.gliding = false;
        if (orbit === controller) stopOrbit();
      },
    });
    if (arrival) arrival = { ...arrival, offer: false };
    openPanel();
    render();
  }

  function stopOrbit() {
    if (orbitWatch) clearInterval(orbitWatch);
    orbitWatch = null;
    if (!orbit) return;
    const stopping = orbit;
    orbit = null;
    for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart'])
      documentRef?.removeEventListener?.(type, stopping.interrupt, {
        capture: true,
      });
    // Still gliding in: the glide is ours to end.
    if (stopping.gliding) {
      stopping.gliding = false;
      viewer.camera.cancelFlight?.();
    }
    if (stopping.active) stopping.stop();
  }

  /** The stamped towns on the globe, joined in the order they were visited. */
  function renderJourney() {
    if (!passport.showMap) {
      if (journey) {
        viewer.dataSources.remove(journey, true);
        journey = null;
      }
      return;
    }
    if (!journey) {
      journey = new Cesium.CustomDataSource('visit-passport');
      viewer.dataSources.add(journey);
    }
    const entities = journey.entities;
    redrawEntities(entities, () => {
      const stamps = stampsInOrder(passport).filter((stamp) =>
        Array.isArray(stamp.point),
      );
      const gold = Cesium.Color.fromCssColorString(STAMP_COLOR);
      for (const stamp of stamps)
        entities.add({
          id: `visit-passport:${stamp.code}`,
          position: Cesium.Cartesian3.fromDegrees(...stamp.point),
          point: {
            pixelSize: 9,
            color: gold,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      if (stamps.length > 1)
        entities.add({
          id: 'visit-passport:route',
          polyline: {
            positions: stamps.map((stamp) =>
              Cesium.Cartesian3.fromDegrees(...stamp.point),
            ),
            width: 2,
            arcType: Cesium.ArcType.GEODESIC,
            clampToGround: true,
            material: new Cesium.PolylineDashMaterialProperty({
              color: gold.withAlpha(0.8),
              dashLength: 14,
            }),
          },
        });
    });
    viewer.scene.requestRender?.();
  }

  /** "Visit 4 · first 5 Nov" for the town shown, if it is stamped. */
  function visitLine() {
    const stamp = passport.stamps[city?.code];
    if (!stamp) return '';
    const count = stamp.count || 1;
    return [
      t('Visit {count}', { count }),
      t('first {date}', {
        date: new Intl.DateTimeFormat(getLocale(), {
          day: 'numeric',
          month: 'short',
        }).format(stamp.first),
      }),
    ].join(' · ');
  }

  // ---- sights --------------------------------------------------------------
  /** The town's sights, read once per town while the tab is open. */
  async function loadSights() {
    // A failed read is tried again the next time the tab opens.
    if (!city || (sights?.code === city.code && sights.status !== 'error'))
      return;
    const forCity = city;
    sightsRequest?.abort();
    const controller = new AbortController();
    sightsRequest = controller;
    sights = { code: forCity.code, status: 'loading', items: [] };
    render();
    const [lon, lat] = forCity.point;
    try {
      const body = await getJson(
        `/api/city-sights?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
        controller.signal,
      );
      if (destroyed || city !== forCity) return;
      sights = {
        code: forCity.code,
        status: 'ready',
        items: (body?.sights ?? []).map((sight, rank) => ({ ...sight, rank })),
      };
    } catch (error) {
      if (error?.name === 'AbortError') return;
      sights = { code: forCity.code, status: 'error', items: [] };
    } finally {
      if (sightsRequest === controller) sightsRequest = null;
    }
    drawSights();
    render();
  }

  function drawSights() {
    if (tab === 'sights' && sights?.code === city?.code)
      sightsLayer.show(sights.items, chosenSight);
    else sightsLayer.hide();
  }

  /** Choose a sight: mark it, and fly in from the south to look at it. */
  function chooseSight(id) {
    const sight = sights?.items.find((item) => item.id === id);
    if (!sight) return;
    chosenSight = id;
    stopOrbit();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        sight.lon,
        sight.lat - SIGHT_VIEW_SOUTH_DEG,
        SIGHT_VIEW_HEIGHT_M,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-35),
        roll: 0,
      },
      duration: 2,
    });
    drawSights();
    render();
  }

  function sightsView() {
    if (!sights || sights.code !== city?.code || sights.status === 'loading')
      return { note: t('Looking for sights…'), items: [] };
    if (sights.status === 'error')
      return { note: t('Sights unavailable right now'), items: [] };
    return {
      note: sights.items.length ? '' : t('No sights found nearby'),
      chosen: chosenSight,
      items: sights.items.map((sight) => {
        const chosen = sight.id === chosenSight;
        return {
          key: sight.id,
          name: sight.name,
          kind: t(SIGHT_KINDS[sight.kind] ?? SIGHT_KINDS.monument),
          color: SIGHT_COLORS[sight.kind] ?? '#ffffff',
          distance: t('{km} km', { km: oneDecimal(sight.km) }),
          chosen,
          article: chosen ? sight.article : null,
          // Commons' own thumbnail of the chosen sight's picture.
          image: chosen && sight.image ? `${sight.image}?width=320` : null,
        };
      }),
    };
  }

  function passView() {
    const stamps = stampsInOrder(passport);
    const day = new Intl.DateTimeFormat(getLocale(), {
      day: 'numeric',
      month: 'short',
    });
    return {
      summary: t('{count} of {total} municipalities visited', {
        count: stamps.length,
        total: MUNICIPALITY_COUNT,
      }),
      challenges: challengeProgress(passport).map((row) => ({
        id: row.id,
        label: t(CHALLENGE_LABELS[row.id]),
        progress: `${row.done} / ${row.total}`,
        done: row.done >= row.total,
        width: `${Math.round((row.done / row.total) * 100)}%`,
      })),
      total: tn(
        totalVisits(passport),
        '{count} visit in all',
        '{count} visits in all',
      ),
      // The towns returned to most, with their count.
      most: mostVisited(passport)
        .filter((stamp) => stamp.count > 1)
        .map((stamp) => ({
          key: stamp.code,
          name: stamp.name,
          count: `×${stamp.count}`,
          detail: [stamp.county, day.format(stamp.last ?? stamp.first)]
            .filter(Boolean)
            .join(' · '),
        })),
      recent: stamps
        .slice(-8)
        .reverse()
        .map((stamp) => ({
          key: stamp.code,
          name: stamp.name,
          count: (stamp.count || 1) > 1 ? `×${stamp.count}` : '',
          detail: [stamp.county, day.format(stamp.first)]
            .filter(Boolean)
            .join(' · '),
        })),
      showMap: passport.showMap,
      cinematic: passport.cinematic,
    };
  }

  function openOnFirstVisit() {
    if (appeared || !documentRef) return;
    appeared = true;
    // Like Recent Imagery: the first appearance opens the panel unless a
    // stored collapse choice exists.
    const panel = documentRef.getElementById?.(PANEL_ID);
    const preference = panel?.dataset?.collapsedPreference;
    if (
      panel?.classList.contains('collapsed') &&
      (preference === undefined || preference === 'default')
    )
      panel.querySelector?.(`[data-collapse-target="${PANEL_ID}"]`)?.click();
  }

  async function playRadio() {
    if (!city || radioBusy) return false;
    radioBusy = true;
    render();
    try {
      await dataManager.setEnabled('radio', true, { origin: 'user' });
      const radio = dataManager.layers.get('radio')?.module;
      for (let i = 0; i < 50 && !radio?.getUIState?.()?.stationCount; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const [lon, lat] = city.point;
      // Sveriges Radio's local channel by the town ("P4 Göteborg") or the
      // county ("P4 Gävleborg"), else the nearest Swedish station.
      const county = String(city.county || '').replace(/s? län$/, '');
      for (const stationQuery of [`P4 ${city.name}`, `P4 ${county}`, '']) {
        const station = radio?.selectRequestedStation?.(
          {
            categoryId: 'all',
            anchor: { lat, lon },
            country: 'SE',
            stationQuery,
          },
          { autoplay: true, origin: 'user' },
        );
        if (station) return true;
      }
      return false;
    } finally {
      radioBusy = false;
      render();
    }
  }

  // ---- presentation -------------------------------------------------------
  function aboutView() {
    const wiki = facts?.wikipedia;
    const town = facts?.town;
    const rows = [];
    if (Number.isFinite(town?.founded))
      rows.push({ label: t('Founded'), value: String(town.founded) });
    if (Number.isFinite(town?.elevation))
      rows.push({
        label: t('Elevation'),
        value: t('{value} m above sea level', { value: whole(town.elevation) }),
      });
    return {
      image: wiki?.image || null,
      extract: wiki?.extract || '',
      rows,
      credit: wiki?.url
        ? { text: t('Text from Wikipedia (CC BY-SA 4.0)'), url: wiki.url }
        : null,
    };
  }

  function peopleView() {
    const municipality = facts?.municipality;
    const town = facts?.town;
    const rows = [];
    if (Number.isFinite(town?.population))
      rows.push({
        label: t('Town ({name})', { name: city.name }),
        value: whole(town.population),
        detail: town.populationYear ? String(town.populationYear) : '',
      });
    if (municipality?.population)
      rows.push({
        label: t('Municipality'),
        value: whole(municipality.population.value),
        // SCB's monthly count names its month; Kolada's its year.
        detail: Number.isFinite(municipality.population.month)
          ? new Intl.DateTimeFormat(getLocale(), {
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(
              Date.UTC(
                municipality.population.year,
                municipality.population.month - 1,
                15,
              ),
            )
          : String(municipality.population.year),
      });
    if (
      Number.isFinite(municipality?.population?.men) &&
      Number.isFinite(municipality?.population?.women)
    )
      rows.push({
        label: t('Women / men'),
        value: `${whole(municipality.population.women)} / ${whole(municipality.population.men)}`,
        detail: '',
      });
    if (municipality?.meanAge)
      rows.push({
        label: t('Mean age'),
        value: t('{value} years', {
          value: oneDecimal(municipality.meanAge.value),
        }),
        detail: String(municipality.meanAge.year),
      });
    const history = municipality?.populationHistory || [];
    const change = populationChange(history);
    return {
      rows,
      spark: change
        ? {
            points: sparklinePoints(history, 220, 44),
            from: String(change.fromYear),
            to: String(change.toYear),
            rising: change.change >= 0,
            text: t('{change} ({percent} %) since {year}', {
              change: formatNumber(change.change, {
                signDisplay: 'exceptZero',
              }),
              percent: formatNumber(change.percent, {
                signDisplay: 'exceptZero',
                maximumFractionDigits: 1,
              }),
              year: change.fromYear,
            }),
          }
        : null,
    };
  }

  function societyView() {
    const m = facts?.municipality;
    const rows = [];
    if (m?.taxRate)
      rows.push({
        label: t('Tax rate'),
        value: `${formatNumber(m.taxRate.value, { maximumFractionDigits: 2 })} %`,
        detail: String(m.taxRate.year),
      });
    if (m?.medianIncome)
      rows.push({
        label: t('Median income, ages 20–64'),
        value: `${SEK.format(m.medianIncome.value)} kr`,
        detail: String(m.medianIncome.year),
      });
    if (m?.unemployment)
      rows.push({
        label: t('Unemployed, ages 18–65'),
        value: `${oneDecimal(m.unemployment.value)} %`,
        detail: String(m.unemployment.year),
      });
    if (m?.turnout)
      rows.push({
        label: t('Turnout, municipal election'),
        value: `${oneDecimal(m.turnout.value)} %`,
        detail: m.turnout.year ? String(m.turnout.year) : '',
      });
    const parties = m?.election?.parties || [];
    const top = Math.max(1, ...parties.map((row) => row.share));
    return {
      rows,
      election: parties.length
        ? {
            // Valmyndigheten names its election; Kolada's figures are dated
            // by the year Kolada repeats them in.
            title: t('Municipal election {year}', {
              year: m.election.year ?? electionYear(m.election.dataYear),
            }),
            parties: parties.map((row) => ({
              party:
                row.party === 'other'
                  ? t('Other')
                  : row.party === 'local'
                    ? row.name
                    : row.party,
              share: `${oneDecimal(row.share)} %`,
              width: `${Math.max(2, (row.share / top) * 100)}%`,
              color: PARTY_COLORS[row.party] || PARTY_COLORS.other,
            })),
          }
        : null,
    };
  }

  /** "No answer from: Polisen, Traffic", or '' when every part answered. */
  function failedLine() {
    if (!live?.failed?.length) return '';
    const sources = LIVE_PARTS.filter(([field]) =>
      live.failed.includes(field),
    ).map(([, label, plain]) => (label ? t(label) : plain));
    return t('No answer from: {sources}', { sources: sources.join(', ') });
  }

  function nowView() {
    if (!live)
      return { loading: true, status: t('Fetching the live picture…') };
    const brief = live.brief;
    const weather = brief?.weather;
    const alerts = Array.isArray(brief?.alerts) ? brief.alerts : [];
    const sun = sunTimes(city.point[1], city.point[0], now());
    const police = live.police;
    return {
      loading: false,
      // Parts still on their way, said once below what has arrived.
      pending: live.pending > 0 ? t('Fetching the live picture…') : '',
      failed: failedLine(),
      weather: weather
        ? {
            value: Number.isFinite(weather.temperatureC)
              ? `${Math.round(weather.temperatureC)}°C`
              : '—',
            detail: [
              // The cockpit briefing's condition words, already translated.
              t(weatherCodeLabel(weather.weatherCode)),
              Number.isFinite(weather.windKph)
                ? t('wind {value} m/s', {
                    value: oneDecimal(weather.windKph / 3.6),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
            source: brief.weatherSource || 'SMHI',
          }
        : null,
      alerts: alerts.map((alert, index) => ({
        key: `${alert.level}:${index}`,
        level: alert.level,
        title: bilingual(alert.title),
        meta: [
          ALERT_LEVEL_KEYS[alert.level]
            ? t(ALERT_LEVEL_KEYS[alert.level])
            : null,
          bilingual(alert.area) || null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      alertsNote:
        brief?.alertsStatus === 'ready' && !alerts.length
          ? t('No warnings in effect')
          : '',
      air: live.air
        ? {
            value: `EAQI ${live.air.label}`, // i18n-ignore: index name
            risk: live.air.risk ? t(live.air.risk) : '',
            color: live.air.color,
            station: t('Measured at {station}', { station: live.air.name }),
          }
        : null,
      police: police
        ? {
            summary: police.length
              ? tn(
                  police.length,
                  '{count} notice in the last 24 hours',
                  '{count} notices in the last 24 hours',
                )
              : t('No notices in the last 24 hours'),
            items: police.slice(0, 3).map((event) => ({
              key: event.id,
              title: event.type,
              time: clock(event.time),
              url: event.link,
            })),
          }
        : null,
      sun:
        sun.polar === 'day'
          ? t('Midnight sun')
          : sun.polar === 'night'
            ? t('Polar night')
            : t('Sunrise {rise} · sunset {set}', {
                rise: clock(sun.rise),
                set: clock(sun.set),
              }),
      trains: trainsView(live.transit?.trains),
      jams: jamsView(live.transit?.jams),
      flights: flightsView(live.transit?.flights),
      kris: krisView(live.kris),
      aurora: auroraView(live.aurora),
      cameras: camerasView(live.cameras),
      radioLabel: radioBusy ? t('Tuning in…') : t('Play local radio'),
      radioBusy,
    };
  }

  /** The town station's next departures; null without the Trafikverket key. */
  function trainsView(trains) {
    if (!trains?.station) return null;
    return {
      title: t('Trains from {station}', { station: trains.station }),
      empty: trains.departures.length
        ? ''
        : t('No departures in the next three hours'),
      items: trains.departures.map((row) => ({
        key: `${row.train}:${row.planned}`,
        time: clock(row.planned),
        destination: row.destination || '—',
        status: row.canceled
          ? t('Cancelled')
          : row.delayMinutes > 0
            ? t('{time} (+{minutes} min)', {
                time: clock(row.expected),
                minutes: row.delayMinutes,
              })
            : '',
        late: row.canceled || row.delayMinutes > 0,
        detail: [
          row.product,
          row.track ? t('track {track}', { track: row.track }) : null,
          row.note,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    };
  }

  /**
   * The nearby Swedavia airports' next departures and arrivals; null without
   * the Swedavia key or when no Swedavia airport serves the town.
   */
  function flightsView(flights) {
    const airports = flights?.airports ?? [];
    if (!airports.length) return null;
    // Late in the evening the board runs on into tomorrow's flights.
    const today = day(now());
    const rows = (list, kind) =>
      list.map((row) => ({
        key: `${kind}:${row.flight}:${row.planned}`,
        time: clock(row.planned),
        tomorrow: day(row.planned) !== today ? t('tomorrow') : '',
        destination: bilingual(row.place) || '—',
        status: row.canceled
          ? t('Cancelled')
          : row.delayMinutes > 0
            ? t('{time} (+{minutes} min)', {
                time: clock(row.expected),
                minutes: row.delayMinutes,
              })
            : // Swedavia's own screen line (Boarding, Go to gate) first.
              bilingual(row.remark) || bilingual(row.status),
        late: row.canceled || row.delayMinutes > 0,
        detail: [
          row.flight,
          row.airline,
          row.terminal,
          row.gate ? t('gate {gate}', { gate: row.gate }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }));
    // Ordinary lanes only: fast track is for the few with a pass.
    const queues = (security) =>
      (security ?? [])
        .filter((queue) => !queue.fastTrack)
        .map((queue) => ({
          key: queue.name,
          label: queue.terminal || '',
          value: t('{minutes} min', { minutes: queue.minutes }),
          busy: queue.overflow || queue.minutes >= 15,
        }));
    return airports.map((airport) => ({
      key: airport.iata,
      title: t('Flights at {airport}', { airport: airport.name }),
      security: queues(airport.security),
      boards: [
        {
          key: 'departures',
          label: t('Departures'),
          icon: 'flight_takeoff',
          empty: t('No upcoming departures'),
          items: rows(airport.departures, 'departures'),
        },
        {
          key: 'arrivals',
          label: t('Arrivals'),
          icon: 'flight_land',
          empty: t('No upcoming arrivals'),
          items: rows(airport.arrivals, 'arrivals'),
        },
      ],
    }));
  }

  /**
   * Tonight's northern lights at the town: the chance, the forecast Kp
   * against what the latitude needs, the clouds and the darkest best hour;
   * and whether the original's aurora oval layer is on.
   */
  function auroraView(outlook) {
    if (!outlook?.level) return null;
    if (outlook.level === 'none')
      return {
        level: 'none',
        title: t('Northern lights: no dark sky tonight'),
        detail: '',
        layerOn: Boolean(dataManager?.isEnabled?.('aurora')),
      };
    return {
      level: outlook.level,
      title: t('Northern lights tonight: {chance}', {
        chance: t(AURORA_CHANCES[outlook.level]),
      }),
      detail: [
        outlook.maxKp !== null
          ? t('Kp {kp} forecast, {need} is enough here', {
              kp: oneDecimal(outlook.maxKp),
              need: outlook.requiredKp,
            })
          : null,
        outlook.scale,
        outlook.cloudPct !== null
          ? t('{pct} % cloud', { pct: outlook.cloudPct })
          : null,
        outlook.dark
          ? t('dark {from}–{to}', {
              from: clock(outlook.dark.from),
              to: clock(outlook.dark.to),
            })
          : null,
        outlook.best
          ? t('best around {time}', { time: clock(outlook.best) })
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      layerOn: Boolean(dataManager?.isEnabled?.('aurora')),
    };
  }

  /**
   * Trafikverket's speed camera sites within the route's radius of the town,
   * the nearest few listed; null without the Trafikverket key.
   */
  function camerasView(cameras) {
    if (!Number.isFinite(cameras?.count)) return null;
    return {
      title: cameras.count
        ? tn(
            cameras.count,
            '{count} speed camera within {km} km',
            '{count} speed cameras within {km} km',
            { km: cameras.radiusKm },
          )
        : t('No speed cameras within {km} km', { km: cameras.radiusKm }),
      items: (cameras.nearest ?? []).map((camera) => ({
        key: camera.id,
        road: camera.road || '',
        name: camera.name,
        detail: [
          facingText(camera.bearing),
          t('{km} km', { km: oneDecimal(camera.km) }),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    };
  }

  /**
   * Point a speed camera out: the layer on, a look at the site from the
   * south, and its card on the map.
   */
  async function showCamera(id) {
    const camera = live?.cameras?.nearest?.find((row) => row.id === id);
    if (!camera) return false;
    stopOrbit();
    const [lon, lat] = camera.point;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        lon,
        lat - CAMERA_VIEW_SOUTH_DEG,
        CAMERA_VIEW_HEIGHT_M,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      duration: 2,
    });
    await dataManager?.setEnabled?.('speed-cameras', true, { origin: 'user' });
    const layer = dataManager?.layers?.get?.('speed-cameras')?.module;
    // The first read of the sites may still be on its way: wait for it, and
    // give up at once when it has failed.
    return pollUntil(
      () => {
        if (destroyed || layer?.selectById?.(id)) return true;
        return layer?.getStats?.().error ? false : undefined;
      },
      { timeoutMs: CAMERA_CARD_WAIT_MS },
    );
  }

  /**
   * Krisinformation.se for the town: its active alerts (VMA) and the newest
   * news for it, its county or the whole country; null until read.
   */
  function krisView(kris) {
    if (!kris) return null;
    const when = (ms) =>
      ms
        ? new Intl.DateTimeFormat(getLocale(), {
            timeZone: 'Europe/Stockholm',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }).format(ms)
        : '';
    const scope = (message) =>
      message.national
        ? t('All of Sweden')
        : message.areas
            .map((area) => area.name)
            .filter(Boolean)
            .slice(0, 2)
            .join(', ');
    return {
      title: 'Krisinformation.se', // i18n-ignore: provider name
      vmas: kris.vmas.map((message) => ({
        key: message.id,
        headline: message.headline,
        text: message.preamble ?? '',
        meta: [scope(message), when(message.published)]
          .filter(Boolean)
          .join(' · '),
        url: message.web,
      })),
      news: kris.news.map((message) => ({
        key: message.id,
        headline: message.headline,
        meta: [when(message.published), scope(message)]
          .filter(Boolean)
          .join(' · '),
        url: message.web,
      })),
      empty:
        kris.vmas.length || kris.news.length
          ? ''
          : t('No messages from Krisinformation.se for the town'),
    };
  }

  /** TomTom's jams around the town; null without the TomTom key. */
  function jamsView(jams) {
    if (!jams) return null;
    return {
      empty: jams.items.length ? '' : t('No queues right now'),
      items: jams.items.map((row, index) => ({
        key: `${index}:${row.from}`,
        title: [row.roads.join('/'), row.description]
          .filter(Boolean)
          .join(' · '),
        detail: [
          Number.isFinite(row.lengthM)
            ? t('{km} km', { km: oneDecimal(row.lengthM / 1000) })
            : null,
          row.delaySeconds > 0
            ? t('+{minutes} min', {
                minutes: Math.max(1, Math.round(row.delaySeconds / 60)),
              })
            : null,
          [row.from, row.to].filter(Boolean).join(' → ') || null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    };
  }

  function render() {
    if (destroyed) return;
    if (!city) {
      publish(null);
      return;
    }
    publish({
      code: city.code,
      name: city.name,
      subtitle: [
        t('{name} municipality', { name: city.municipality }),
        city.county,
      ]
        .filter(Boolean)
        .join(' · '),
      visits: visitLine(),
      coatOfArms: facts?.town?.coatOfArms || null,
      status,
      error: status === 'error' ? t('Facts unavailable right now') : '',
      tab,
      tabs: TABS.map(([id, label]) => ({
        id,
        label: t(label),
        active: id === tab,
      })),
      about: facts ? aboutView() : null,
      people: facts ? peopleView() : null,
      society: facts ? societyView() : null,
      now: nowView(),
      sights: tab === 'sights' ? sightsView() : null,
      pass: passView(),
      arrival,
      // Provider names; the live transport ones only once they show.
      source: [
        'SCB · Kolada · Valmyndigheten · Wikidata · Wikipedia · SMHI · Polisen', // i18n-ignore: provider names
        live?.transit?.trains?.station ? 'Trafikverket' : null, // i18n-ignore: provider name
        live?.transit?.jams ? 'TomTom' : null, // i18n-ignore: provider name
        live?.transit?.flights?.airports?.length ? 'Swedavia' : null, // i18n-ignore: provider name
        live?.kris ? 'Krisinformation.se' : null, // i18n-ignore: provider name
        live?.aurora?.level ? 'NOAA SWPC' : null, // i18n-ignore: provider name
        live?.cameras && !live?.transit?.trains?.station
          ? 'Trafikverket' // i18n-ignore: provider name
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }

  const disconnect = connect({
    setTab(id) {
      if (!TABS.some(([tabId]) => tabId === id)) return;
      tab = id;
      if (liveIsDue()) void loadLive();
      if (id !== 'sights') chosenSight = null;
      if (id === 'sights') void loadSights();
      drawSights();
      render();
    },
    chooseSight: (id) => chooseSight(id),
    clearSight() {
      chosenSight = null;
      drawSights();
      render();
    },
    playRadio,
    flyIn,
    showCamera: (id) => showCamera(id),
    // The original's aurora oval (NOAA OVATION) on the map.
    async showAurora() {
      await dataManager?.setEnabled?.('aurora', true, { origin: 'user' });
      render();
    },
    toggleCinematic() {
      passport.cinematic = !passport.cinematic;
      if (!passport.cinematic) stopOrbit();
      savePassport(storage, passport);
      render();
    },
    togglePassMap() {
      passport.showMap = !passport.showMap;
      savePassport(storage, passport);
      renderJourney();
      render();
    },
  });

  renderJourney();
  const removeLocaleListener = onLocaleChange(render);
  watchPanelOnce();
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void visit(), SETTLE_DELAY_MS);
  });
  // A view that is already over a town counts as a visit.
  timer = setTimeout(() => void visit(), SETTLE_DELAY_MS);

  return {
    /** The town presented now, or null. */
    get city() {
      return city;
    },
    visit,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      request?.abort();
      liveRequest?.abort();
      removeMoveEnd();
      removeLocaleListener();
      stopWatchingPanel?.();
      stopOrbit();
      clearTimeout(arrivalTimer);
      if (journey) viewer.dataSources.remove(journey, true);
      journey = null;
      sightsRequest?.abort();
      sightsLayer.destroy();
      disconnect();
      publish(null);
    },
  };
}

/** Whether the CITY panel shows its contents: there, and not folded. */
function panelIsOpen(documentRef) {
  const panel = documentRef?.getElementById?.(PANEL_ID);
  return Boolean(panel) && !panel.classList?.contains('collapsed');
}

/**
 * Tell when the CITY panel folds or unfolds. Gives a function that stops
 * telling, or null while there is no panel (or nothing to watch it with).
 */
function watchPanelClass(documentRef, onChange) {
  const panel = documentRef?.getElementById?.(PANEL_ID);
  const Observer =
    documentRef?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (!panel || !Observer) return null;
  const observer = new Observer(() => onChange());
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
