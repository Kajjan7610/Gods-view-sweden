import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { redrawEntities } from '../redrawEntities.js';
import {
  EVENT_CATEGORIES,
  categoryColor,
  spreadAroundPlaces,
} from './records.js';
import { POLICE_OVERLAY_SOURCE_ID, buildPoliceCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createPolisenEventsSource } from './source.js';

const PICK_PREFIX = 'se-polisen:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const CATEGORY_LABELS = Object.freeze({
  violence: msg('Violence and threats'),
  traffic: msg('Traffic'),
  fire: msg('Fires and accidents'),
  property: msg('Theft and damage'),
  drugs: msg('Drugs and drunkenness'),
  missing: msg('Missing persons'),
  other: msg('Other'),
  summary: msg('County summaries'),
});
/** Time windows, newest notices first; the API holds roughly ten days. */
const WINDOWS = Object.freeze({
  day: 24 * 60 * 60_000,
  days3: 3 * 24 * 60 * 60_000,
  all: Infinity,
});
/** Notices younger than this are drawn bright. */
const FRESH_MS = 3 * 60 * 60_000;

/**
 * Own one Swedish police display: Polisen's event notices as dots coloured
 * by category, spread around the municipality each names (the API gives no
 * exact place), with click-to-card selection. Share links carry it as
 * token 0x.
 */
export function createPolisenEventsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Polisen events require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  // A notice is spread a little around its place, at the place's height.
  const _ground = createGroundHeights(terrain, () => render());
  const position = (row, [lon, lat]) =>
    Cesium.Cartesian3.fromDegrees(lon, lat, _ground.heightOf(row.id));
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
  let _events = [];
  let _window = 'day';
  const _show = { summaries: false };
  const _eventById = new Map();
  let _positions = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const visibleEvents = () => {
    const since = Date.now() - WINDOWS[_window];
    return _events.filter(
      (row) =>
        row.time >= since && (row.category !== 'summary' || _show.summaries),
    );
  };

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _eventById.get(_selectedId) : null;
    const point = row && (_positions.get(row.id) || row.point);
    if (!row || !point) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(POLICE_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = buildPoliceCard(row, { linkable: Boolean(openExternal) });
    card.position = position(row, point);
    if (card.interactive && row.link) {
      card.activate = () => {
        openExternal(row.link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(POLICE_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** Resolve a scene pick to a notice id of this layer, or null. */
  function pickedEvent(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _eventById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: POLICE_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const row = _eventById.get(_selectedId);
        if (row?.link && openExternal) openExternal(row.link);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedEvent(picked) : null;
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
      overlayHost.clearSource(POLICE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(POLICE_OVERLAY_SOURCE_ID, false);
    }
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const shown = visibleEvents();
    _positions = spreadAroundPlaces(shown);
    const now = Date.now();
    redrawEntities(entities, () => {
      // Oldest first, so the newest dot of a place is drawn on top.
      for (const row of [...shown].reverse()) {
        const fresh = now - row.time < FRESH_MS;
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row, _positions.get(row.id) || row.point),
          point: {
            pixelSize: fresh ? 10 : 8,
            color: Cesium.Color.fromCssColorString(
              categoryColor(row.category),
            ).withAlpha(fresh ? 1 : 0.7),
            outlineColor:
              row.precision === 'county'
                ? Cesium.Color.WHITE.withAlpha(0.85)
                : Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: row.precision === 'county' ? 2 : 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    });
    if (_selectedId && !_eventById.has(_selectedId)) _selectedId = null;
    if (_selectedId && !shown.some((row) => row.id === _selectedId))
      _selectedId = null;
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function setWindow(id) {
    if (_window === id) return;
    _window = id;
    render();
    _rowListener?.();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: 'polisen-events',
    name: 'Police Events (Sweden)',
    icon: '🚓',
    source: 'Polisen',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('Polisen events layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('polisen-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(POLICE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
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
          snapshot.events.map((row) => [row.id, row.time, row.type]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _events = snapshot.events;
          _eventById.clear();
          for (const row of _events) _eventById.set(row.id, row);
          console.log(
            `[Data:PolisenEvents] Updated: ${_events.length} notices`,
          );
        }
        // Rendered on every refresh: the time window moves on.
        render();
        _ground.place(_events.filter((row) => Array.isArray(row.point)));
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:PolisenEvents] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Polisen events unavailable');
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
      _ground.clear();
      _eventById.clear();
      _events = [];
      _positions = new Map();
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
      const shown = visibleEvents();
      const legend = EVENT_CATEGORIES.map(({ id, color }) => ({
        label: t(CATEGORY_LABELS[id]),
        color,
        count: shown.filter((row) => row.category === id).length,
      })).filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'day',
            label: t('24 H'),
            active: _window === 'day',
            title: t('Notices from the last 24 hours'),
            onClick: () => setWindow('day'),
          },
          {
            id: 'days3',
            label: t('3 DAYS'),
            active: _window === 'days3',
            title: t('Notices from the last three days'),
            onClick: () => setWindow('days3'),
          },
          {
            id: 'all',
            label: t('ALL'),
            active: _window === 'all',
            title: t('All 500 notices Polisen publishes, about ten days'),
            onClick: () => setWindow('all'),
          },
          {
            id: 'summaries',
            label: t('SUMMARIES'),
            active: _show.summaries,
            title: t('Also show county-wide night and evening summaries'),
            onClick: () => toggle('summaries'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are Polisen’s event notices, often published hours later. Polisen names only the municipality, so dots are spread around its centre; a white ring marks a county-wide notice. Click a dot for the notice.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      const shown = visibleEvents();
      return {
        count: shown.length,
        notices: _events.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
