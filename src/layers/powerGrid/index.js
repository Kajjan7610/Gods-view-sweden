import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { FLOW_KINDS, SWEDISH_AREAS, flowColor, flowWidth } from './records.js';
import {
  POWER_GRID_OVERLAY_SOURCE_ID,
  buildAreaCard,
  formatMw,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createPowerGridSource } from './source.js';

const PICK_PREFIX = 'se-kraftnat:';
const LABEL_SOURCE_ID = 'power-grid-labels';
/** Flow lines float above terrain and buildings. */
const LINE_HEIGHT_M = 12_000;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 40,
  collisionCapacity: 40,
  moving: false,
});
const KIND_LABELS = Object.freeze({
  internal: msg('Between Swedish zones'),
  import: msg('Into Sweden'),
  export: msg('Out of Sweden'),
});
const AREA_BY_ID = new Map(SWEDISH_AREAS.map((area) => [area.id, area]));

/** The point halfway along a link, for its label. */
function midpoint([lon1, lat1], [lon2, lat2]) {
  return [(lon1 + lon2) / 2, (lat1 + lat2) / 2];
}

/**
 * Own one Swedish power-system display: an arrow on every link to and
 * between the Swedish bidding zones, pointing the way the power flows, as
 * thick as the flow, labelled in MW; and a card per zone with its import,
 * export and Sweden's production by type. Share links carry it as token 0r.
 */
export function createPowerGridLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Power grid requires a snapshot source');
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
  let _snapshot = { links: [], areas: [], production: {}, updated: null };

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const area = _selectedId ? AREA_BY_ID.get(_selectedId) : null;
    if (!area || !_snapshot.links.length) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        POWER_GRID_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildAreaCard(area, _snapshot);
    card.position = Cesium.Cartesian3.fromDegrees(...area.point);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      POWER_GRID_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedArea(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return AREA_BY_ID.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: POWER_GRID_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedArea(picked) : null;
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
    for (const id of [POWER_GRID_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  const LABEL_BASE = Object.freeze({
    variant: 'label',
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

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled) {
      for (const area of SWEDISH_AREAS)
        entries.push({
          ...LABEL_BASE,
          id: `power-grid-area:${area.id}`,
          position: Cesium.Cartesian3.fromDegrees(...area.point),
          title: area.id,
          accent: flowColor('internal'),
          priority: 2000,
        });
      for (const link of _snapshot.links) {
        entries.push({
          ...LABEL_BASE,
          id: `power-grid-flow:${link.id}`,
          position: Cesium.Cartesian3.fromDegrees(
            ...midpoint(link.fromPoint, link.toPoint),
            LINE_HEIGHT_M,
          ),
          title: t('{mw} MW', { mw: formatMw(link.mw) }),
          accent: flowColor(link.kind),
          priority: 1000 + link.mw,
        });
        const foreign = link.kind === 'import' ? link.from : link.to;
        const foreignPoint =
          link.kind === 'import' ? link.fromPoint : link.toPoint;
        if (link.kind !== 'internal')
          entries.push({
            ...LABEL_BASE,
            id: `power-grid-end:${link.id}`,
            position: Cesium.Cartesian3.fromDegrees(...foreignPoint),
            title: foreign,
            accent: '#b0bec5',
            priority: 500,
          });
      }
    }
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const link of _snapshot.links) {
        if (link.mw < 1) continue;
        entities.add({
          id: `power-grid-line:${link.id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
              ...link.fromPoint,
              LINE_HEIGHT_M,
              ...link.toPoint,
              LINE_HEIGHT_M,
            ]),
            width: flowWidth(link.mw) * 2,
            arcType: Cesium.ArcType.GEODESIC,
            material: new Cesium.PolylineArrowMaterialProperty(
              Cesium.Color.fromCssColorString(flowColor(link.kind)).withAlpha(
                0.9,
              ),
            ),
          },
        });
        if (link.kind !== 'internal')
          entities.add({
            id: `power-grid-end:${link.id}`,
            position: Cesium.Cartesian3.fromDegrees(
              ...(link.kind === 'import' ? link.fromPoint : link.toPoint),
            ),
            point: {
              pixelSize: 8,
              color: Cesium.Color.fromCssColorString('#b0bec5'),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
      }
      for (const area of SWEDISH_AREAS)
        entities.add({
          id: `${PICK_PREFIX}${area.id}`,
          position: Cesium.Cartesian3.fromDegrees(...area.point),
          point: {
            pixelSize: 18,
            color: Cesium.Color.fromCssColorString(flowColor('internal')),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
    } finally {
      entities.resumeEvents();
    }
    publishLabels();
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'power-grid',
    name: 'Power Grid (Sweden)',
    icon: '🔌',
    source: 'Svenska kraftnät',
    // SvK publishes quarter-hours; the proxy caches five minutes.
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('Power grid layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('power-grid');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(POWER_GRID_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
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
        _snapshot = snapshot;
        render();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:PowerGrid] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Power grid unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _snapshot = { links: [], areas: [], production: {}, updated: null };
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
      for (const link of _snapshot.links)
        counts.set(link.kind, (counts.get(link.kind) || 0) + 1);
      const legend = FLOW_KINDS.map(({ id, color }) => ({
        label: t(KIND_LABELS[id]),
        color,
        count: counts.get(id) || 0,
      }));
      return {
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Arrows show the power flowing now on each link to and between the four bidding zones, as thick as the flow. Click a zone for its import, export and Sweden’s production by type.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: _snapshot.links.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
