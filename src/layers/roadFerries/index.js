import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { statusColor } from './records.js';
import {
  ROAD_FERRIES_OVERLAY_SOURCE_ID,
  buildFerryCard,
  ferryClock,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createRoadFerriesSource } from './source.js';

export const ROAD_FERRIES_LAYER_ID = 'road-ferries';
const PICK_PREFIX = 'se-ferry:';
const OUTLINE_COLOR = '#ffffff';
const LABEL_SOURCE_ID = 'road-ferries-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 60,
  collisionCapacity: 30,
  moving: false,
});

/** The legend rows, in the order the statuses matter. */
const STATUSES = Object.freeze([
  Object.freeze({
    id: 'message',
    label: msg('With a message from Trafikverket'),
  }),
  Object.freeze({ id: 'running', label: msg('Departures without a message') }),
  Object.freeze({
    id: 'idle',
    label: msg('No departures in the next three hours'),
  }),
]);

/**
 * Own one Swedish road ferry display: Trafikverket's ferry routes as dots,
 * amber where Trafikverket has a message for the route, with the next
 * departure time beside each and click-to-card selection listing the next
 * departures. Share links carry it as token 10.
 */
export function createRoadFerriesLayer({
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
    throw new TypeError('Road ferries require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  /** Where a card or label sits: the dot's place on the ellipsoid (ECEF). */
  const placeOf = (row) => {
    const at = position(row);
    return fromDegrees(at.lon, at.lat, at.height);
  };
  let _viewer = null;
  let _dots = null;
  /** The ids of the rows the set holds: the ones a new height can move. */
  let _drawn = new Set();
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _routes = [];
  let _times = true;
  const _routeById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(ROAD_FERRIES_LAYER_ID);

  /** A route's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: row.status === 'idle' ? 8 : 12,
    color: statusColor(row.status),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 2,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  /** The route's departures still to leave by the clock of the moment. */
  const upcoming = (route) =>
    route.departures.filter((departure) => departure.at >= now() - 60_000);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _routeById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        ROAD_FERRIES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildFerryCard({ ...row, departures: upcoming(row) });
    card.position = placeOf(row);
    overlayHost.setEntries(
      ROAD_FERRIES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRoute(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _routeById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      ROAD_FERRIES_LAYER_ID,
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
      const hit = pickedRoute(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(ROAD_FERRIES_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(ROAD_FERRIES_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    for (const id of [ROAD_FERRIES_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _times) {
      for (const row of _routes) {
        const next = upcoming(row)[0];
        if (!next) continue;
        entries.push({
          id: `road-ferries-label:${row.id}`,
          position: placeOf(row),
          variant: 'label',
          title: ferryClock(next.at),
          accent: statusColor(row.status),
          // Routes with a message win the label budget, then the soonest.
          priority:
            (row.messages.length ? 1e9 : 0) -
            Math.round((next.at - now()) / 1000),
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 10,
          verticalOnly: true,
          placement: 'above',
        });
      }
    }
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids
      .filter((id) => _drawn.has(id))
      .map((id) => _routeById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    _dots.set(_routes.map(dotOf));
    _drawn = new Set(_routes.map((row) => row.id));
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: ROAD_FERRIES_LAYER_ID,
    name: 'Road ferries (Sweden)',
    icon: '⛴️',
    source: 'Trafikverket',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('Road ferries layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: ROAD_FERRIES_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(ROAD_FERRIES_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
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
        const signature = JSON.stringify(
          snapshot.routes.map((row) => [
            row.id,
            row.status,
            row.messages,
            row.departures.map((departure) => departure.at),
          ]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          _routes = snapshot.routes;
          _routeById.clear();
          for (const row of _routes) _routeById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_routes);
          try {
            render();
          } catch (e) {
            console.warn('[Data:RoadFerries] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Ferry data unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(`[Data:RoadFerries] Updated: ${_routes.length} routes`);
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_routes);
          // The clock moves on: the next departure beside each dot too.
          publishLabels();
          if (_selectedId) publishSelectedCard();
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:RoadFerries] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Ferry data unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _ground.clear();
      _routeById.clear();
      _routes = [];
      _drawn = new Set();
      _signature = null;
      _dots?.dispose();
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
      const legend = STATUSES.map((entry) => ({
        label: t(entry.label),
        color: statusColor(entry.id),
        count: _routes.filter((row) => row.status === entry.id).length,
      }));
      return {
        chips: [
          {
            id: 'times',
            label: t('NEXT DEPARTURE'),
            active: _times,
            title: t('Write the next departure time beside each ferry route'),
            onClick: () => {
              _times = !_times;
              publishLabels();
              _rowListener?.();
            },
          },
        ],
        legend: legend
          .filter((item) => item.count > 0)
          .map((item, index) =>
            index === 0
              ? {
                  ...item,
                  blurb: t(
                    'Dots are Trafikverket’s road ferry routes with their next departures in the coming three hours and Trafikverket’s messages for the route (cancellations, reduced capacity, planned closures). Click a route for its departures.',
                  ),
                }
              : item,
          ),
      };
    },

    getStats() {
      return {
        count: _routes.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
