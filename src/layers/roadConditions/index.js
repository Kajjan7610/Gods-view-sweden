import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  INCIDENT_KINDS,
  OTHER_INCIDENT,
  ROAD_CONDITION_CODES,
  UNKNOWN_CONDITION_COLOR,
  conditionColor,
  incidentColor,
} from './records.js';
import {
  ROAD_OVERLAY_SOURCE_ID,
  buildConditionCard,
  buildIncidentCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createTrafikverketRoadsSource } from './source.js';

const PICK_PREFIX = 'se-road:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const CONDITION_LABELS = Object.freeze({
  1: msg('Normal'),
  2: msg('Difficult (risk of)'),
  3: msg('Very difficult'),
  4: msg('Ice and snow surface'),
});
const KIND_LABELS = Object.freeze({
  accident: msg('Accident'),
  closure: msg('Road closed'),
  obstacle: msg('Obstacle'),
  roadwork: msg('Roadwork'),
  important: msg('Important traffic info'),
  restriction: msg('Restriction'),
  ferry: msg('Ferry'),
  message: msg('Traffic message'),
  minor: msg('Speed limits and lane closures'),
  other: msg('Other'),
});
/** The ring around a closed road's white dot and its dashed stretch. */
const CLOSURE_RING = Cesium.Color.fromCssColorString('#ff1744');
/** Point size by Trafikverket SeverityCode (1, 2, 4, 5; higher is worse). */
const severityPixels = (severity) =>
  ({ 5: 15, 4: 13, 2: 10, 1: 8 })[severity] || 9;
const conditionWidth = (code) => ({ 3: 6, 2: 4, 4: 4, 1: 2 })[code] || 3;

/**
 * Own one Swedish road display: winter road condition per stretch and live
 * incidents from Trafikverket, with click-to-card selection. Share links
 * carry it as token 8.
 */
export function createTrafikverketRoadsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Trafikverket roads require a snapshot source');
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
  let _selected = null;
  let _selectedCardId = null;
  let _conditions = [];
  let _incidents = [];
  const _show = {
    conditions: true,
    normal: false,
    incidents: true,
    minor: false,
  };
  const _conditionById = new Map();
  const _incidentById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function selectedRow() {
    if (!_selected) return null;
    return _selected.kind === 'c'
      ? _conditionById.get(_selected.id)
      : _incidentById.get(_selected.id);
  }

  function anchorOf(row) {
    if (row.point) return row.point;
    const line = row.lines?.[0];
    return line ? line[Math.floor(line.length / 2)] : null;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = selectedRow();
    const anchor = row && anchorOf(row);
    if (!row || !anchor) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(ROAD_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card =
      _selected.kind === 'c'
        ? buildConditionCard(row)
        : buildIncidentCard(row, { linkable: Boolean(openExternal) });
    card.position = Cesium.Cartesian3.fromDegrees(anchor[0], anchor[1]);
    if (card.interactive && row.link) {
      card.activate = () => {
        openExternal(row.link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(ROAD_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** Resolve a scene pick to {kind, id} of this layer, or null. */
  function pickedRow(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [kind, ...rest] = pickId.slice(PICK_PREFIX.length).split(':');
    // Ids may themselves contain ':'; the entity suffix is the last segment.
    const id = rest.length > 1 ? rest.slice(0, -1).join(':') : rest[0];
    const map = kind === 'c' ? _conditionById : _incidentById;
    return map.has(id) ? { kind, id } : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Like fire perimeters, deliberately NOT registered in the pick-ownership
    // registry: long road lines would otherwise make sibling cards inert.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: ROAD_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const row = selectedRow();
        if (row?.link && openExternal) openExternal(row.link);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedRow(picked) : null;
      if (hit) {
        _selected = hit;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selected) {
        _selected = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearSelection() {
    _selected = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(ROAD_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(ROAD_OVERLAY_SOURCE_ID, false);
    }
  }

  const positions = (line) =>
    line.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      if (_show.conditions) {
        for (const row of _conditions) {
          if (row.code === 1 && !_show.normal) continue;
          const color = Cesium.Color.fromCssColorString(
            conditionColor(row.code),
          ).withAlpha(row.code === 1 ? 0.55 : 0.9);
          row.lines.forEach((line, index) =>
            entities.add({
              id: `${PICK_PREFIX}c:${row.id}:${index}`,
              polyline: {
                positions: positions(line),
                clampToGround: true,
                width: conditionWidth(row.code),
                material: new Cesium.ColorMaterialProperty(color),
              },
            }),
          );
        }
      }
      if (_show.incidents) {
        for (const row of _incidents) {
          if (row.kind === 'minor' && !_show.minor) continue;
          const closure = row.kind === 'closure';
          const color = Cesium.Color.fromCssColorString(
            incidentColor(row.kind),
          );
          // Dashed, so an incident's stretch never reads as a road condition.
          row.lines.forEach((line, index) =>
            entities.add({
              id: `${PICK_PREFIX}i:${row.id}:line${index}`,
              polyline: {
                positions: positions(line),
                clampToGround: true,
                width: closure ? 4 : 3,
                material: new Cesium.PolylineDashMaterialProperty({
                  color: (closure ? CLOSURE_RING : color).withAlpha(0.8),
                  dashLength: 14,
                }),
              },
            }),
          );
          entities.add({
            id: `${PICK_PREFIX}i:${row.id}:point`,
            position: Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1]),
            point: {
              pixelSize:
                row.kind === 'minor' ? 6 : severityPixels(row.severity),
              color,
              outlineColor: closure
                ? CLOSURE_RING
                : Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: closure ? 3 : 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }
      }
    } finally {
      entities.resumeEvents();
    }
    if (_selected) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: 'trafikverket-roads',
    name: 'Road Conditions (Sweden)',
    icon: '🛣️',
    source: 'Trafikverket',
    updateInterval: 180000,

    init(viewer) {
      if (_viewer)
        throw new Error('Trafikverket roads layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('trafikverket-roads');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(ROAD_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
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
        const signature = JSON.stringify([
          snapshot.conditions.map((row) => [row.id, row.code]),
          snapshot.incidents.map((row) => [row.id, row.kind, row.severity]),
        ]);
        if (signature !== _signature) {
          _signature = signature;
          _conditions = snapshot.conditions;
          _incidents = snapshot.incidents;
          _conditionById.clear();
          _incidentById.clear();
          for (const row of _conditions) _conditionById.set(row.id, row);
          for (const row of _incidents) _incidentById.set(row.id, row);
          render();
          console.log(
            `[Data:TrafikverketRoads] Updated: ${_conditions.length} stretches, ${_incidents.length} incidents`,
          );
        } else if (_selected) publishSelectedCard();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:TrafikverketRoads] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Trafikverket feed unavailable');
        _stale = false;
        _rowListener?.();
        // Enabling succeeded; the row reports the failure and the next
        // interval retries. A missing key keeps the layer on, explained.
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _conditionById.clear();
      _incidentById.clear();
      _conditions = [];
      _incidents = [];
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
      const codeCount = (code) =>
        _conditions.filter((row) => row.code === code).length;
      const kindCount = (kind) =>
        _incidents.filter((row) => row.kind === kind).length;
      const conditionLegend = Object.entries(ROAD_CONDITION_CODES)
        .filter(([code]) => Number(code) !== 1 || _show.normal)
        .map(([code, { color }]) => ({
          label: t(CONDITION_LABELS[code]),
          color,
          count: codeCount(Number(code)),
        }));
      const unknown = _conditions.filter(
        (row) => !ROAD_CONDITION_CODES[row.code],
      ).length;
      if (unknown)
        conditionLegend.push({
          label: t('Other condition'),
          color: UNKNOWN_CONDITION_COLOR,
          count: unknown,
        });
      const incidentLegend = [...INCIDENT_KINDS, OTHER_INCIDENT]
        .filter(({ id }) => id !== 'minor' || _show.minor)
        .map(({ id, color }) => ({
          label: t(KIND_LABELS[id]),
          color,
          count: kindCount(id),
        }))
        .filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'conditions',
            label: t('ROAD CONDITION'),
            active: _show.conditions,
            title: t(
              'Winter road surface per stretch; Trafikverket publishes it 1 November to 30 April',
            ),
            onClick: () => toggle('conditions'),
          },
          {
            id: 'normal',
            label: t('INCL. NORMAL'),
            active: _show.normal,
            disabled: !_show.conditions,
            title: t('Also draw stretches with normal road condition'),
            onClick: () => toggle('normal'),
          },
          {
            id: 'incidents',
            label: t('INCIDENTS'),
            active: _show.incidents,
            title: t(
              'Accidents, roadworks, obstacles and restrictions in effect now',
            ),
            onClick: () => toggle('incidents'),
          },
          {
            id: 'minor',
            label: t('INCL. MINOR'),
            active: _show.minor,
            disabled: !_show.incidents,
            title: t(
              'Also show speed limits, lane closures, overtaking bans and weight limits at roadworks',
            ),
            onClick: () => toggle('minor'),
          },
        ],
        legend: [
          ...(_show.conditions ? conditionLegend : []),
          ...(_show.incidents ? incidentLegend : []),
        ].map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Lines show road condition, dots show incidents; dot size follows severity. Click either for details.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      const problems = _conditions.filter((row) => row.code !== 1).length;
      const shownIncidents = _show.minor
        ? _incidents.length
        : _incidents.filter((row) => row.kind !== 'minor').length;
      return {
        count:
          (_show.conditions ? problems : 0) +
          (_show.incidents ? shownIncidents : 0),
        conditions: _conditions.length,
        incidents: _incidents.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
