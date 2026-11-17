import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { ALERT_KINDS, alertColor } from './records.js';
import { TRANSIT_ALERTS_OVERLAY_SOURCE_ID, buildStopCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createTransitAlertsSource } from './source.js';

export const TRANSIT_ALERTS_LAYER_ID = 'transit-alerts';
const PICK_PREFIX = 'se-trafikstorning:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const KIND_LABELS = Object.freeze({
  closed: msg('Stop closed or not served'),
  moved: msg('Stop moved'),
  other: msg('Other disruption'),
});
const KIND_SIZE = Object.freeze({ closed: 11, moved: 9, other: 8 });
const OUTLINE_COLOR = Object.freeze([0, 0, 0, 0.7]);
const SCALE_BY_DISTANCE = Object.freeze({
  near: 2e4,
  nearValue: 1.4,
  far: 2e6,
  farValue: 0.6,
});

/**
 * Own one Swedish public-transport disruption display: every stop area with
 * an active alert from the regional operators, coloured by how serious it is,
 * and a card with the alerts' text. Share links carry it as token 0q.
 */
export function createTransitAlertsLayer({
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
    throw new TypeError('Transit disruptions require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  let _viewer = null;
  let _dots = null;
  // The stops drawn now, as they were drawn.
  let _drawn = new Map();
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _stops = [];
  let _pending = [];
  const _stopById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(TRANSIT_ALERTS_LAYER_ID);

  /** A stop's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: KIND_SIZE[row.kind] || 8,
    color: alertColor(row.kind),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stopById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStopCard(row);
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    overlayHost.setEntries(
      TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStop(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stopById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      TRANSIT_ALERTS_LAYER_ID,
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
      const hit = pickedStop(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(TRANSIT_ALERTS_LAYER_ID, pickId)
      )
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
    picking?.unregisterPickOwner?.(TRANSIT_ALERTS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(TRANSIT_ALERTS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(TRANSIT_ALERTS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    // Only dots drawn now move, looking as they were drawn.
    const rows = ids.map((id) => _drawn.get(id)).filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    _drawn = new Map();
    _dots.set(_stops.map(dotOf));
    _drawn = new Map(_stops.map((row) => [row.id, row]));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: TRANSIT_ALERTS_LAYER_ID,
    name: 'Transit Disruptions (Sweden)',
    icon: '🚏',
    source: 'Trafiklab',
    // The proxy caches a quarter of an hour (a minute while stops load).
    updateInterval: 120000,

    init(viewer) {
      if (_viewer)
        throw new Error('Transit disruptions layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: TRANSIT_ALERTS_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(TRANSIT_ALERTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
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
        // Always the newest rows, so a card reads the alerts as they are now.
        _stops = snapshot.stops;
        _pending = snapshot.pending;
        _stopById.clear();
        for (const row of _stops) _stopById.set(row.id, row);
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_stops);
        // The proxy answers the same for a quarter of an hour: the dots are
        // drawn again only when one of them would look different.
        const signature = JSON.stringify(
          _stops.map((row) => [row.id, row.kind, row.point]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          try {
            render();
          } catch (e) {
            console.warn('[Data:TransitAlerts] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Transit disruptions unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
        } else if (_selectedId) publishSelectedCard();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:TransitAlerts] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Transit disruptions unavailable');
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
      _stopById.clear();
      _stops = [];
      _pending = [];
      _drawn = new Map();
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
      const counts = new Map();
      for (const row of _stops)
        counts.set(row.kind, (counts.get(row.kind) || 0) + 1);
      const legend = ALERT_KINDS.map(({ id, color }) => ({
        label: t(KIND_LABELS[id]),
        color,
        count: counts.get(id) || 0,
      }));
      const blurb = _pending.length
        ? t(
            'Stops are still loading for {count} operators; their disruptions appear within a few minutes.',
            { count: _pending.length },
          )
        : t(
            'Points are stops with an active disruption from the regional operators (Trafiklab GTFS Regional). Click a stop for the operator’s message.',
          );
      return {
        legend: legend.map((item, index) =>
          index === 0 ? { ...item, blurb } : item,
        ),
      };
    },

    getStats() {
      return {
        count: _stops.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
