import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { WARNING_LEVELS, levelColor, warningLevel } from './records.js';
import {
  LEVEL_TITLES,
  SMHI_WARNINGS_OVERLAY_SOURCE_ID,
  SMHI_WARNINGS_PAGE,
  buildWarningCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSmhiWarningsSource } from './source.js';

const PICK_PREFIX = 'se-smhiwarn:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Vertex average of a polygon's largest outer ring: where its card stands. */
function anchorOf(row) {
  let ring = null;
  for (const polygon of row.polygons)
    if (!ring || polygon.outer.length > ring.length) ring = polygon.outer;
  if (!ring?.length) return null;
  const sum = ring.reduce(
    (acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat],
    [0, 0],
  );
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/**
 * Own one Swedish weather warning display: SMHI's impact-based warnings as
 * areas coloured by level (yellow, orange, red; messages behind a toggle),
 * paler while they have yet to start, with click-to-card selection. Share
 * links carry it as token 0y.
 */
export function createSmhiWarningsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SMHI warnings require a snapshot source');
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
  let _areas = [];
  const _show = { messages: false, upcoming: true };
  const _areaById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const visibleAreas = () =>
    _areas.filter(
      (row) =>
        (row.level !== 'MESSAGE' || _show.messages) &&
        (!row.upcoming || _show.upcoming),
    );

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _areaById.get(_selectedId) : null;
    const anchor = row && anchorOf(row);
    if (!row || !anchor) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        SMHI_WARNINGS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildWarningCard(row, { linkable: Boolean(openExternal) });
    card.position = Cesium.Cartesian3.fromDegrees(anchor[0], anchor[1]);
    if (card.interactive) {
      card.activate = () => {
        openExternal(SMHI_WARNINGS_PAGE);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SMHI_WARNINGS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to an area id of this layer, or null. */
  function pickedArea(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    // Area ids are "<warning>:<area>"; the entity suffix is the last segment.
    const id = pickId
      .slice(PICK_PREFIX.length)
      .split(':')
      .slice(0, -1)
      .join(':');
    return _areaById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Like the road layer, deliberately NOT registered in the pick-ownership
    // registry: large areas would otherwise make sibling cards inert.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SMHI_WARNINGS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (openExternal) openExternal(SMHI_WARNINGS_PAGE);
        return;
      }
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

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(SMHI_WARNINGS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(SMHI_WARNINGS_OVERLAY_SOURCE_ID, false);
    }
  }

  const positions = (ring) =>
    ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      // Least severe first, so red is drawn over orange over yellow.
      for (const row of visibleAreas()) {
        const rank = warningLevel(row.level)?.rank ?? 0;
        const color = Cesium.Color.fromCssColorString(levelColor(row.level));
        row.polygons.forEach((polygon, index) => {
          entities.add({
            id: `${PICK_PREFIX}${row.id}:fill${index}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                positions(polygon.outer),
                polygon.holes.map(
                  (hole) => new Cesium.PolygonHierarchy(positions(hole)),
                ),
              ),
              material: new Cesium.ColorMaterialProperty(
                color.withAlpha(row.upcoming ? 0.12 : 0.3),
              ),
              classificationType: Cesium.ClassificationType.BOTH,
              zIndex: rank,
            },
          });
          entities.add({
            id: `${PICK_PREFIX}${row.id}:edge${index}`,
            polyline: {
              positions: positions([...polygon.outer, polygon.outer[0]]),
              clampToGround: true,
              width: row.level === 'MESSAGE' ? 1.5 : 2.5,
              material: row.upcoming
                ? new Cesium.PolylineDashMaterialProperty({
                    color: color.withAlpha(0.85),
                    dashLength: 16,
                  })
                : new Cesium.ColorMaterialProperty(color.withAlpha(0.9)),
              zIndex: rank,
            },
          });
        });
      }
    } finally {
      entities.resumeEvents();
    }
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    if (_selectedId && !visibleAreas().some((row) => row.id === _selectedId))
      _selectedId = null;
    render();
    if (!_selectedId) publishSelectedCard();
    _rowListener?.();
  }

  const layer = {
    id: 'smhi-warnings',
    name: 'Weather Warnings (Sweden)',
    icon: '⚠️',
    source: 'SMHI',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('SMHI warnings layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('smhi-warnings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SMHI_WARNINGS_OVERLAY_SOURCE_ID, true);
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
        const signature = JSON.stringify(
          snapshot.areas.map((row) => [
            row.id,
            row.level,
            row.start,
            row.end,
            row.upcoming,
            row.published,
          ]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _areas = snapshot.areas;
          _areaById.clear();
          for (const row of _areas) _areaById.set(row.id, row);
          render();
          console.log(
            `[Data:SmhiWarnings] Updated: ${_areas.length} warning areas`,
          );
        } else if (_selectedId) publishSelectedCard();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SmhiWarnings] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('SMHI warnings unavailable');
        _stale = false;
        _rowListener?.();
        // Enabling succeeded; the row reports the failure and the next
        // interval retries.
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _areaById.clear();
      _areas = [];
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
      const shown = visibleAreas();
      const legend = [...WARNING_LEVELS]
        .reverse()
        .map(({ code, color }) => ({
          label: t(LEVEL_TITLES[code]),
          color,
          count: shown.filter((row) => row.level === code).length,
        }))
        .filter((item) => item.count > 0);
      if (!legend.length)
        legend.push({
          label: t('No warnings in effect'),
          color: '#4caf50',
          count: 0,
        });
      return {
        chips: [
          {
            id: 'messages',
            label: t('MESSAGES'),
            active: _show.messages,
            title: t(
              'Also show SMHI messages, such as risk of water shortage, high flows or fire risk',
            ),
            onClick: () => toggle('messages'),
          },
          {
            id: 'upcoming',
            label: t('UPCOMING'),
            active: _show.upcoming,
            title: t('Also show warnings that have yet to start, drawn paler'),
            onClick: () => toggle('upcoming'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Areas are SMHI’s impact-based weather warnings, coloured by level; paler areas start later. Click an area for what happens and what to think about.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      const shown = visibleAreas();
      return {
        count: shown.length,
        areas: _areas.length,
        red: shown.filter((row) => row.level === 'RED').length,
        orange: shown.filter((row) => row.level === 'ORANGE').length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
