import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  EVENT_CATEGORIES,
  categoryColor,
  spreadAroundPlaces,
} from './records.js';
import { POLICE_OVERLAY_SOURCE_ID, buildPoliceCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createPolisenEventsSource } from './source.js';

export const POLISEN_EVENTS_LAYER_ID = 'polisen-events';
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
/** A county-wide notice has a white ring; the rest a dark one. */
const COUNTY_OUTLINE = Object.freeze([1, 1, 1, 0.85]);
const PLACE_OUTLINE = Object.freeze([0, 0, 0, 0.8]);

/** A category's colour at `alpha`, made once per category and alpha. */
const _colors = new Map();
function categoryColorAt(category, alpha) {
  const key = `${category}:${alpha}`;
  let color = _colors.get(key);
  if (!color) {
    const [r, g, b] = cssColor(categoryColor(category));
    color = Object.freeze([r, g, b, alpha]);
    _colors.set(key, color);
  }
  return color;
}

/**
 * Own one Swedish police display: Polisen's event notices as dots coloured
 * by category, spread around the municipality each names (the API gives no
 * exact place), with click-to-card selection. Share links carry it as
 * token 0x.
 */
export function createPolisenEventsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Polisen events require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  // A notice is spread a little around its place, at the place's height.
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row, [lon, lat]) => ({
    lon,
    lat,
    height: _ground.heightOf(row.id),
  });
  let _viewer = null;
  let _dots = null;
  // The notices drawn now, and the time their brightness was judged at.
  let _drawnIds = new Set();
  let _drawnAt = 0;
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

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(POLISEN_EVENTS_LAYER_ID);
  const visibleEvents = () => {
    const since = now() - WINDOWS[_window];
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
    const at = position(row, point);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    if (card.accessibilityLabel && row.link) {
      card.activate = () => {
        openExternal(row.link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(POLICE_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** Resolve a pick id to a notice id of this layer, or null. */
  function pickedEvent(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _eventById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      POLISEN_EVENTS_LAYER_ID,
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
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y);
      if (
        cardHit?.sourceId === POLICE_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      ) {
        const row = _eventById.get(_selectedId);
        if (row?.link && openExternal) openExternal(row.link);
      }
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedEvent(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(POLISEN_EVENTS_LAYER_ID, pickId)
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
    picking?.unregisterPickOwner?.(POLISEN_EVENTS_LAYER_ID);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(POLICE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(POLICE_OVERLAY_SOURCE_ID, false);
    }
  }

  /** A notice's dot as the set draws it, bright while it is fresh at `at`. */
  const dotOf = (row, at) => {
    const fresh = at - row.time < FRESH_MS;
    const county = row.precision === 'county';
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row, _positions.get(row.id) || row.point),
      height: 'clampGround',
      pixelSize: fresh ? 10 : 8,
      color: categoryColorAt(row.category, fresh ? 1 : 0.7),
      outlineColor: county ? COUNTY_OUTLINE : PLACE_OUTLINE,
      outlineWidth: county ? 2 : 1.5,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    // Only dots drawn now move, looking as they were drawn.
    const rows = ids
      .filter((id) => _drawnIds.has(id))
      .map((id) => _eventById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map((row) => dotOf(row, _drawnAt)));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    const shown = visibleEvents();
    _positions = spreadAroundPlaces(shown);
    const at = now();
    // Oldest first, so the newest dot of a place is drawn on top.
    _drawnIds = new Set();
    _dots.set([...shown].reverse().map((row) => dotOf(row, at)));
    _drawnIds = new Set(shown.map((row) => row.id));
    _drawnAt = at;
    if (_selectedId && !_eventById.has(_selectedId)) _selectedId = null;
    if (_selectedId && !shown.some((row) => row.id === _selectedId))
      _selectedId = null;
    publishSelectedCard();
    requestRender();
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
    id: POLISEN_EVENTS_LAYER_ID,
    name: 'Police Events (Sweden)',
    icon: '🚓',
    source: 'Polisen',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('Polisen events layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: POLISEN_EVENTS_LAYER_ID,
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
      overlayHost?.setVisible?.(POLICE_OVERLAY_SOURCE_ID, true);
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
      clearSelection();
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
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_events.filter((row) => Array.isArray(row.point)));
        // Rendered on every refresh: the time window moves on, and a
        // drawing that failed is made again.
        try {
          render();
        } catch (e) {
          console.warn('[Data:PolisenEvents] Draw error:', e?.message || e);
          _lastError = e?.message || msg('Polisen events unavailable');
        }
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

    destroy() {
      layer.disable();
      _ground.clear();
      _eventById.clear();
      _events = [];
      _positions = new Map();
      _drawnIds = new Set();
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
