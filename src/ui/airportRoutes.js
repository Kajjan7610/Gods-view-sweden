/**
 * Today's routes on the globe (Swedish fork): from the airport board, every
 * destination of a Swedavia airport's departures today as an arc from the
 * airport, thicker for more flights, with the destination's name and count.
 * A click on a destination opens the board on its flights. Routes come from
 * /api/airport-routes (Swedavia's day and OurAirports' positions).
 */
import * as Cesium from 'cesium';
import { getLocale, onLocaleChange, t } from '../i18n/index.js';

const PICK_PREFIX = 'airport-route:';
const LABEL_SOURCE_ID = 'airport-route-labels';
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 120,
  collisionCapacity: 40,
  moving: false,
});
const ROUTE_COLOR = '#ffc94d';
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
 * into an arc whose top rises with the distance flown.
 */
export function arcPositions(from, to, steps = ARC_STEPS) {
  const start = Cesium.Cartographic.fromDegrees(from.lon, from.lat);
  const end = Cesium.Cartographic.fromDegrees(to.lon, to.lat);
  const geodesic = new Cesium.EllipsoidGeodesic(start, end);
  const lift = (geodesic.surfaceDistance / 1000) * ARC_LIFT_PER_KM;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const at = geodesic.interpolateUsingFraction(f);
    points.push(
      Cesium.Cartesian3.fromRadians(
        at.longitude,
        at.latitude,
        Math.sin(Math.PI * f) * lift,
      ),
    );
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
  const centre = Cesium.Cartographic.fromDegrees(lon, lat);
  const reach = points
    .map(
      (p) =>
        new Cesium.EllipsoidGeodesic(
          centre,
          Cesium.Cartographic.fromDegrees(p.lon, p.lat),
        ).surfaceDistance,
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
 * Own the routes for one viewer.
 * @param {{ openBoard: (iata: string, query: string) => void }} options
 */
export function createAirportRoutes({
  viewer,
  overlayHost,
  publish,
  openBoard,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  let destroyed = false;
  let day = null;
  let request = null;
  const source = new Cesium.CustomDataSource('airport-routes');
  void viewer.dataSources.add(source);

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
    source.entities.removeAll();
    const entries = [];
    if (day) {
      const color = Cesium.Color.fromCssColorString(ROUTE_COLOR);
      for (const route of day.routes) {
        const id = `${PICK_PREFIX}${route.iata}`;
        source.entities.add({
          id,
          polyline: {
            positions: arcPositions(day.airport, route),
            width: routeWidth(route.flights),
            material: new Cesium.PolylineGlowMaterialProperty({
              color: color.withAlpha(0.75),
              glowPower: 0.18,
            }),
            arcType: Cesium.ArcType.NONE,
          },
        });
        const position = Cesium.Cartesian3.fromDegrees(route.lon, route.lat);
        source.entities.add({
          id: `${id}:point`,
          position,
          point: {
            pixelSize: 6,
            color,
            outlineColor: Cesium.Color.fromCssColorString('#04101a'),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        entries.push({
          id,
          position,
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
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
    overlayHost.setVisible?.(LABEL_SOURCE_ID, Boolean(day));
    viewer.scene.requestRender?.();
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
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          view.lon,
          view.lat,
          view.height,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 2.5,
      });
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

  const clicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clicks.setInputAction((click) => {
    if (!day) return;
    const label = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
      sourceId: LABEL_SOURCE_ID,
    });
    const id = String(
      label?.entryId ?? viewer.scene.pick(click.position)?.id?.id ?? '',
    );
    if (!id.startsWith(PICK_PREFIX)) return;
    const code = id.slice(PICK_PREFIX.length).split(':')[0];
    const route = day.routes.find((row) => row.iata === code);
    if (route) openBoard(day.airport.iata, route.iata);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

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
      clicks.destroy();
      removeLocale?.();
      overlayHost.clearSource?.(LABEL_SOURCE_ID);
      viewer.dataSources.remove(source, true);
      publish(null);
    },
  };
}
