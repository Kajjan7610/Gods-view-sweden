import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { FLOW_CLASSES, flowClass } from './records.js';
import {
  RIVER_FLOW_OVERLAY_SOURCE_ID,
  buildFlowCard,
  flowColor,
  formatFlow,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createRiverFlowSource } from './source.js';

const PICK_PREFIX = 'se-flow:';
const LABEL_SOURCE_ID = 'river-flow-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 300,
  collisionCapacity: 40,
  moving: false,
});
const CLASS_LABELS = Object.freeze({
  brook: msg('Under 1 m³/s'),
  stream: msg('1 to 10 m³/s'),
  river: msg('10 to 50 m³/s'),
  large: msg('50 to 150 m³/s'),
  major: msg('150 m³/s or more'),
});

/**
 * Own one Swedish river flow display: SMHI's discharge stations sized and
 * coloured by the latest 15-minute flow, the largest flows written beside
 * them, and click-to-card selection. Share links carry it as token 0o.
 */
export function createRiverFlowLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('River flow requires a snapshot source');
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
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _selectedCardId = null;
  let _stations = [];
  let _values = true;
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        RIVER_FLOW_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildFlowCard(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      RIVER_FLOW_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStation(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stationById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: RIVER_FLOW_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStation(picked) : null;
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
    for (const id of [RIVER_FLOW_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _values) {
      for (const row of _stations) {
        entries.push({
          id: `river-flow-label:${row.id}`,
          position: position(row),
          variant: 'label',
          title: `${formatFlow(row.flow)} m³/s`, // i18n-ignore: unit
          accent: flowColor(row.flow),
          // The largest rivers win the label budget.
          priority: Math.round(row.flow * 100),
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

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of _stations) {
        const entry = flowClass(row.flow);
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: entry?.size ?? 6,
            color: Cesium.Color.fromCssColorString(flowColor(row.flow)),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    publishLabels();
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'river-flow',
    name: 'River Flow (Sweden)',
    icon: '🏞️',
    source: 'SMHI',
    updateInterval: 900000,

    init(viewer) {
      if (_viewer) throw new Error('River flow layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('river-flow');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(RIVER_FLOW_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
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
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [row.id, row.updated, row.flow]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          render();
          console.log(`[Data:RiverFlow] Updated: ${_stations.length} stations`);
        }
        _ground.place(_stations);
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:RiverFlow] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('River flow unavailable');
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
      _stationById.clear();
      _stations = [];
      _signature = null;
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
      const legend = FLOW_CLASSES.map((entry) => ({
        label: t(CLASS_LABELS[entry.id]),
        color: entry.color,
        count: _stations.filter((row) => flowClass(row.flow) === entry).length,
      })).filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'values',
            label: t('VALUES'),
            active: _values,
            title: t('Write the flow beside the largest rivers'),
            onClick: () => {
              _values = !_values;
              publishLabels();
              _rowListener?.();
            },
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are SMHI’s discharge stations, sized and coloured by the latest 15-minute flow in cubic metres per second. Click a station for its river, catchment and whether the flow is rising or falling.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: _stations.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
