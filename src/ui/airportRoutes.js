/**
 * Today's routes on the globe (Swedish fork): from the airport board, every
 * destination of a Swedavia airport's departures today as an arc from the
 * airport, thicker for more flights, with the destination's name and count.
 * A click on a destination opens the board on its flights. Routes come from
 * /api/airport-routes (Swedavia's day and OurAirports' positions).
 */
import { getLocale, onLocaleChange, t } from '../i18n/index.js';
import { fromDegrees, fromRadians } from '../geo/ellipsoid.js';
import { toRadians } from '../geo/vector.js';
import { geodesicLine, surfaceDistance } from '../geo/geodesic.js';
import { hexColor } from '../render/color.js';
import { drawOf, findCamera, findFrame } from '../render/rendererOf.js';
import { inputFor } from '../input/dispatcher.js';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

export const AIRPORT_ROUTES_ID = 'airport-routes';
/** The destinations' dots, a set of their own beside the arcs. */
const DOTS_ID = 'airport-route-dots';
const PICK_PREFIX = 'airport-route:';
const LABEL_SOURCE_ID = 'airport-route-labels';
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 120,
  collisionCapacity: 40,
  moving: false,
});
const ROUTE_COLOR = '#ffc94d';
const ARC_STYLE = Object.freeze({
  kind: 'glow',
  color: hexColor(ROUTE_COLOR, 0.75),
  power: 0.18,
});
const OUTLINE_COLOR = '#04101a';
/** Points along each arc, and how high its middle rises per km flown. */
const ARC_STEPS = 48;
const ARC_LIFT_PER_KM = 60;
/** The overview: high over the airport, looking straight down. */
const OVERVIEW_HEIGHT_M = 4_500_000;

const bilingual = (value) =>
  !value
    ? ''
    : String(getLocale() || '').startsWith('sv')
      ? value.sv
      : value.en;

/** An arc's width in pixels: one flight a hairline, a dozen a ribbon. */
export const routeWidth = (flights) =>
  Math.min(7, 1.5 + Math.log2(Math.max(1, flights)) * 1.4);

/**
 * Points along the great circle from `from` to `to` ({ lat, lon }), lifted
 * into an arc whose top rises with the distance flown: ECEF metres.
 */
export function arcPositions(from, to, steps = ARC_STEPS) {
  const geodesic = geodesicLine(
    toRadians(from.lon),
    toRadians(from.lat),
    toRadians(to.lon),
    toRadians(to.lat),
  );
  const lift = (geodesic.distance / 1000) * ARC_LIFT_PER_KM;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const at = geodesic.at(f);
    points.push(fromRadians(at.lon, at.lat, Math.sin(Math.PI * f) * lift));
  }
  return points;
}

/**
 * Where to look from: straight down over the routes' centre (the airport
 * and its destinations, weighted by flights), high enough to hold the
 * airport and most of them (the farthest few may fall outside).
 */
export function overview(day) {
  const points = [
    { lat: day.airport.lat, lon: day.airport.lon, weight: 4 },
    ...day.routes.map((route) => ({
      lat: route.lat,
      lon: route.lon,
      weight: route.flights,
    })),
  ];
  const total = points.reduce((sum, p) => sum + p.weight, 0);
  const lat = points.reduce((sum, p) => sum + p.lat * p.weight, 0) / total;
  const lon = points.reduce((sum, p) => sum + p.lon * p.weight, 0) / total;
  const centre = { lon: toRadians(lon), lat: toRadians(lat) };
  const reach = points
    .map((p) =>
      surfaceDistance(centre, { lon: toRadians(p.lon), lat: toRadians(p.lat) }),
    )
    .sort((a, b) => a - b);
  const span = reach[Math.floor((reach.length - 1) * 0.85)] ?? 0;
  return {
    lat,
    lon,
    height: Math.min(12_000_000, Math.max(OVERVIEW_HEIGHT_M / 2, span * 2.6)),
  };
}

/**
 * Own the routes for one scene object (`viewer`).
 * @param {{ openBoard: (iata: string, query: string) => void }} options
 */
export function createAirportRoutes({
  viewer: host,
  overlayHost,
  publish,
  openBoard,
  fetchImpl = (...args) => globalThis.fetch(...args),
  // The clicks on the globe: the application's input dispatcher.
  input = (forHost) => inputFor(forHost),
}) {
  let destroyed = false;
  let day = null;
  let request = null;
  const port = drawOf(host);
  const arcs = port.lines({ id: AIRPORT_ROUTES_ID });
  const dots = port.points({ id: DOTS_ID });
  const requestRender = () => findFrame(host)?.requestRender(AIRPORT_ROUTES_ID);

  function render() {
    if (destroyed) return;
    if (!day) {
      publish(null);
      return;
    }
    const flights = day.routes.reduce((sum, route) => sum + route.flights, 0);
    publish({
      iata: day.airport.iata,
      name: day.airport.name,
      label: t(
        'Routes today: {destinations} destinations · {flights} departures',
        {
          destinations: day.routes.length,
          flights,
        },
      ),
    });
  }

  function draw() {
    const lines = [];
    const points = [];
    const entries = [];
    if (day) {
      for (const route of day.routes) {
        const id = `${PICK_PREFIX}${route.iata}`;
        lines.push({
          id,
          positions: arcPositions(day.airport, route),
          widthPx: routeWidth(route.flights),
          mode: '3d',
          style: ARC_STYLE,
        });
        points.push({
          id: `${id}:point`,
          pos: { lon: route.lon, lat: route.lat, height: 0 },
          pixelSize: 6,
          color: ROUTE_COLOR,
          outlineColor: OUTLINE_COLOR,
          outlineWidth: 1.5,
          disableDepthTest: Number.POSITIVE_INFINITY,
        });
        entries.push({
          id,
          position: fromDegrees(route.lon, route.lat),
          variant: 'label',
          title: `${bilingual(route.place) || route.iata} · ${route.flights}`,
          accent: ROUTE_COLOR,
          // The busiest destinations win a crowded view.
          priority: route.flights,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: true,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 6,
          verticalOnly: true,
          placement: 'above',
        });
      }
    }
    arcs.set(lines);
    dots.set(points);
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
    overlayHost.setVisible?.(LABEL_SOURCE_ID, Boolean(day));
    requestRender();
  }

  async function show(iata) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetchImpl(`/api/airport-routes?iata=${iata}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (destroyed || request !== controller) return;
      day = body;
      draw();
      render();
      const view = overview(day);
      findCamera(host)?.flyTo(
        { lon: view.lon, lat: view.lat, height: view.height },
        {
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          durationS: 2.5,
        },
      );
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn('[AirportRoutes] load failed:', error?.message || error);
    } finally {
      if (request === controller) request = null;
    }
  }

  function hide() {
    request?.abort();
    day = null;
    draw();
    render();
  }

  registerPickOwner(
    AIRPORT_ROUTES_ID,
    (pickedId) =>
      typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
  );
  // A scene with no renderer input bound takes no clicks.
  let clicks = null;
  try {
    clicks = input(host) ?? null;
  } catch {
    clicks = null;
  }
  const removeClick = clicks?.onClick((click) => {
    if (!day) return;
    const at = click.screenPosition;
    const label = overlayHost.hitTest?.(at?.x, at?.y, {
      sourceId: LABEL_SOURCE_ID,
    });
    const id = String(label?.entryId ?? resolvePickId(click.topHit) ?? '');
    if (!id.startsWith(PICK_PREFIX)) return;
    const code = id.slice(PICK_PREFIX.length).split(':')[0];
    const route = day.routes.find((row) => row.iata === code);
    if (route) openBoard(day.airport.iata, route.iata);
  });

  const removeLocale = onLocaleChange(() => {
    draw();
    render();
  });

  return {
    show,
    hide,
    destroy() {
      destroyed = true;
      request?.abort();
      removeClick?.();
      unregisterPickOwner(AIRPORT_ROUTES_ID);
      removeLocale?.();
      overlayHost.clearSource?.(LABEL_SOURCE_ID);
      arcs.dispose();
      dots.dispose();
      requestRender();
      publish(null);
    },
  };
}
