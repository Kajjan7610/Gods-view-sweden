import { msg, onLocaleChange, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { analystRows } from '../analystRows.js';
import { queueColor, queueRank } from './records.js';
import {
  QUEUE_STATUS_LABELS,
  ROAD_QUEUES_OVERLAY_SOURCE_ID,
  buildPointCard,
  buildRouteCard,
  directionOf,
  duration,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createRoadQueuesSource } from './source.js';

export const ROAD_QUEUES_LAYER_ID = 'road-queues';
export const ROAD_QUEUES_LINES_SET_ID = `${ROAD_QUEUES_LAYER_ID}:routes`;
export const ROAD_QUEUES_POINTS_SET_ID = `${ROAD_QUEUES_LAYER_ID}:points`;
const PICK_PREFIX = 'se-queue:';
const DOT_OUTLINE = Object.freeze([0, 0, 0, 0.7]);
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** The legend rows, worst first; a point's verdicts share the colours. */
const LEGEND = Object.freeze(['impossible', 'congested', 'heavy', 'freeflow']);
const AS_ROUTE = Object.freeze({
  queue: 'congested',
  slow: 'heavy',
  normal: 'freeflow',
});
const routeWidth = (status) =>
  ({ impossible: 7, congested: 6, heavy: 5, freeflow: 3 })[status] ?? 2;
const pointPixels = (status) =>
  ({ queue: 11, slow: 9, normal: 6 })[status] ?? 5;

/** A CSS colour at `alpha`, as a renderer colour made once per both. */
const _colors = new Map();
function colorAt(css, alpha) {
  const key = `${css}|${alpha}`;
  let color = _colors.get(key);
  if (!color) {
    const [r, g, b] = cssColor(css);
    color = Object.freeze([r, g, b, alpha]);
    _colors.set(key, color);
  }
  return color;
}

/**
 * Own one display of Trafikverket's measured traffic: its travel-time
 * stretches coloured by its own verdict, and its detectors as dots coloured
 * by the speed now against the normal for the hour. Click-to-card on both.
 * Share links carry it as token 11.
 */
export function createRoadQueuesLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Road queues require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  let _viewer = null;
  let _lines = null;
  let _dots = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  /** {kind: 'r'|'p', id} of the selected row, or null. */
  let _selected = null;
  let _offLocale = null;
  let _routes = [];
  let _points = [];
  const _routeById = new Map();
  const _pointById = new Map();
  const _show = { points: true, onlyQueues: false };

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(ROAD_QUEUES_LAYER_ID);
  const shown = (status) => !_show.onlyQueues || queueRank(status) > 0;

  /** The stretch's middle: the middle point of its first line. */
  const routeMiddle = (route) => {
    const line = route.lines[0];
    return line ? line[Math.floor(line.length / 2)] : null;
  };
  const routeName = (route) => t('Travel time · {name}', { name: route.name });
  const pointName = (point) => {
    const direction = directionOf(point.side);
    return direction
      ? t('Measuring point · {direction}', { direction })
      : t('Measuring point');
  };
  const statusLabel = (status) =>
    t(QUEUE_STATUS_LABELS[status] ?? QUEUE_STATUS_LABELS.unknown);
  const kmh = (speed) => (Number.isFinite(speed) ? Math.round(speed) : null);

  const placeOf = (point) =>
    fromDegrees(point.point[0], point.point[1], _ground.heightOf(point.id));

  const dotOf = (point) => ({
    id: `${PICK_PREFIX}p:${point.id}`,
    pos: {
      lon: point.point[0],
      lat: point.point[1],
      height: _ground.heightOf(point.id),
    },
    height: 'clampGround',
    pixelSize: pointPixels(point.status),
    color: colorAt(
      queueColor(point.status),
      point.status === 'unknown' ? 0.6 : 1,
    ),
    outlineColor: DOT_OUTLINE,
    outlineWidth: 1,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  const linesOf = (route) =>
    route.lines.map((line, index) => ({
      id: `${PICK_PREFIX}r:${route.id}:${index}`,
      positions: line.map(([lon, lat]) => fromDegrees(lon, lat)),
      widthPx: routeWidth(route.status),
      mode: 'draped',
      style: {
        kind: 'solid',
        color: colorAt(
          queueColor(route.status),
          route.status === 'freeflow'
            ? 0.6
            : route.status === 'unknown'
              ? 0.45
              : 0.95,
        ),
      },
    }));

  /** Where a stretch's card sits: its middle vertex. */
  const routePlace = (route) => {
    const line = route.lines[0];
    const [lon, lat] = line[Math.floor(line.length / 2)];
    return fromDegrees(lon, lat);
  };

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row =
      _selected?.kind === 'r'
        ? _routeById.get(_selected.id)
        : _selected?.kind === 'p'
          ? _pointById.get(_selected.id)
          : null;
    if (!row) {
      _selected = null;
      overlayHost.setEntries(
        ROAD_QUEUES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card =
      _selected.kind === 'r' ? buildRouteCard(row) : buildPointCard(row);
    card.position = _selected.kind === 'r' ? routePlace(row) : placeOf(row);
    overlayHost.setEntries(
      ROAD_QUEUES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRow(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [kind, id] = pickId.slice(PICK_PREFIX.length).split(':');
    if (kind === 'r' && _routeById.has(id)) return { kind, id };
    if (kind === 'p' && _pointById.has(id)) return { kind, id };
    return null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      ROAD_QUEUES_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
    );
    // A viewer with no renderer input bound takes no clicks.
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const at = click.screenPosition;
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(at?.x, at?.y)) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedRow(pickId);
      if (hit) {
        _selected = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(ROAD_QUEUES_LAYER_ID, pickId))
        return;
      if (_selected) {
        _selected = null;
        publishSelectedCard();
        requestRender();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(ROAD_QUEUES_LAYER_ID);
  }

  function clearOverlays() {
    _selected = null;
    if (!overlayHost) return;
    overlayHost.clearSource(ROAD_QUEUES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(ROAD_QUEUES_OVERLAY_SOURCE_ID, false);
  }

  const shownPoints = () =>
    _show.points ? _points.filter((point) => shown(point.status)) : [];

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const drawn = new Set(shownPoints().map((point) => point.id));
    const rows = ids
      .filter((id) => drawn.has(id))
      .map((id) => _pointById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    if (_selected?.kind === 'p' && ids.includes(_selected.id))
      publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots || !_lines) return;
    _lines.set(_routes.filter((route) => shown(route.status)).flatMap(linesOf));
    _dots.set(shownPoints().map(dotOf));
    if (_selected) publishSelectedCard();
    requestRender();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: ROAD_QUEUES_LAYER_ID,
    name: 'Queues and travel times (Sweden)',
    icon: '🚦',
    source: 'Trafikverket',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Road queues layer is already initialized');
      _viewer = viewer;
      const draw = drawOf(viewer);
      // Road lines drape on every surface, as the road conditions do.
      _lines = draw.lines({
        id: ROAD_QUEUES_LINES_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _dots = draw.points({
        id: ROAD_QUEUES_POINTS_SET_ID,
        // Terrain only once the dots have their ground heights: clamping
        // a thousand dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
      // An open card follows the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selected) publishSelectedCard();
      });
    },

    enable() {
      _enabled = true;
      if (_lines) _lines.show = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(ROAD_QUEUES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
      if (_lines) _lines.show = false;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      requestRender();
    },

    async update() {
      if (!_enabled || !_dots) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stale = snapshot.stale;
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : now();
        _lastError = null;
        _routes = snapshot.routes;
        _points = snapshot.points;
        _routeById.clear();
        for (const row of _routes) _routeById.set(row.id, row);
        _pointById.clear();
        for (const row of _points) _pointById.set(row.id, row);
        // The drawing changes only with a verdict or a place; the numbers on
        // an open card change every minute.
        const signature = JSON.stringify([
          _routes.map((row) => [row.id, row.status, row.lines[0]?.length]),
          _points.map((row) => [row.id, row.status]),
        ]);
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_points);
          try {
            render();
          } catch (e) {
            console.warn('[Data:RoadQueues] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Queue data unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(
            `[Data:RoadQueues] Updated: ${_routes.length} stretches, ${_points.length} points`,
          );
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_points);
          if (_selected) publishSelectedCard();
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:RoadQueues] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Queue data unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _offLocale?.();
      _offLocale = null;
      layer.disable();
      _ground.clear();
      _routeById.clear();
      _pointById.clear();
      _routes = [];
      _points = [];
      _signature = null;
      _lines?.dispose();
      _dots?.dispose();
      _lines = null;
      _dots = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const count = (status) =>
        _routes.filter((row) => row.status === status).length +
        _points.filter((row) => AS_ROUTE[row.status] === status).length;
      const legend = LEGEND.map((status) => ({
        label: t(QUEUE_STATUS_LABELS[status]),
        color: queueColor(status),
        count: count(status),
      })).filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'points',
            label: t('MEASURING POINTS'),
            active: _show.points,
            title: t(
              'Show Trafikverket’s detectors, coloured by the speed now against the normal for the hour',
            ),
            onClick: () => toggle('points'),
          },
          {
            id: 'only-queues',
            label: t('ONLY QUEUES'),
            active: _show.onlyQueues,
            title: t('Hide what flows freely'),
            onClick: () => toggle('onlyQueues'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Lines are Trafikverket’s travel-time stretches with its own verdict; dots are its detectors, red where the speed is under half the normal for the hour, amber where it is well under. Stockholm and Göteborg, a few around Malmö. Click for the numbers.',
                ),
              }
            : item,
        ),
        // The airports' security queues follow this switch
        // (src/ui/airportQueues.js).
        info: t(
          'With the layer on, the security queues at Arlanda, Landvetter and Bromma (Swedavia) also show over their terminals.',
        ),
      };
    },

    /** What a picked stretch or point is called, and where it is. */
    findByQuery(pickId) {
      const hit = pickedRow(pickId);
      if (!hit) return null;
      if (hit.kind === 'r') {
        const route = _routeById.get(hit.id);
        const [lon, lat] = routeMiddle(route);
        return { name: routeName(route), latitude: lat, longitude: lon };
      }
      const point = _pointById.get(hit.id);
      return {
        name: pointName(point),
        latitude: point.point[1],
        longitude: point.point[0],
      };
    },

    /**
     * The stretches and measuring points shown, named as findByQuery names
     * them: a stretch at its middle, a point where it measures.
     */
    getAnalystRecords(maxCount = 3000) {
      if (!_enabled) return [];
      const routes = analystRows(
        _routes.filter((route) => shown(route.status)),
        maxCount,
        {
          place: routeMiddle,
          name: routeName,
          extra: (route) => ({
            status: statusLabel(route.status),
            travelTime: duration(route.travelTimeS),
            normalTravelTime: duration(route.normalS),
            speedKmh: kmh(route.speedKmh),
          }),
        },
      );
      if (routes.length >= maxCount) return routes;
      const points = analystRows(shownPoints(), maxCount - routes.length, {
        name: pointName,
        extra: (point) => ({
          status: statusLabel(point.status),
          speedKmh: kmh(point.speed),
          normalSpeedKmh: kmh(point.normalSpeed),
          vehiclesPerHour: Number.isFinite(point.flow) ? point.flow : null,
        }),
      });
      return [...routes, ...points];
    },

    getStats() {
      return {
        count: _routes.length + _points.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
