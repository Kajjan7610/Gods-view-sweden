import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { ALERT_KINDS, alertColor } from './records.js';
import { TRANSIT_ALERTS_OVERLAY_SOURCE_ID, buildStopCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createTransitAlertsSource } from './source.js';

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

/**
 * Own one Swedish public-transport disruption display: every stop area with
 * an active alert from the regional operators, coloured by how serious it is,
 * and a card with the alerts' text. Share links carry it as token 0q.
 */
export function createTransitAlertsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Transit disruptions require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, () => render());
  const position = (row) =>
    Cesium.Cartesian3.fromDegrees(
      row.point[0],
      row.point[1],
      _ground.heightOf(row.id),
    );
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _selectedCardId = null;
  let _stops = [];
  let _pending = [];
  const _stopById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stopById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStopCard(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      TRANSIT_ALERTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStop(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stopById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: TRANSIT_ALERTS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStop(picked) : null;
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(TRANSIT_ALERTS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(TRANSIT_ALERTS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of _stops)
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: KIND_SIZE[row.kind] || 8,
            color: Cesium.Color.fromCssColorString(alertColor(row.kind)),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.4, 2e6, 0.6),
          },
        });
    } finally {
      entities.resumeEvents();
    }
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'transit-alerts',
    name: 'Transit Disruptions (Sweden)',
    icon: '🚏',
    source: 'Trafiklab',
    // The proxy caches a quarter of an hour (a minute while stops load).
    updateInterval: 120000,

    init(viewer) {
      if (_viewer)
        throw new Error('Transit disruptions layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('transit-alerts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(TRANSIT_ALERTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
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
            : Date.now();
        _lastError = null;
        _stops = snapshot.stops;
        _pending = snapshot.pending;
        _stopById.clear();
        for (const row of _stops) _stopById.set(row.id, row);
        render();
        _ground.place(_stops);
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

    destroy(viewer = _viewer) {
      layer.disable();
      _ground.clear();
      _stopById.clear();
      _stops = [];
      _pending = [];
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
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
