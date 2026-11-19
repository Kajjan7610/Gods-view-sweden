import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { statusColor } from './records.js';
import { REST_AREAS_OVERLAY_SOURCE_ID, buildRestAreaCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createRestAreasSource } from './source.js';

export const REST_AREAS_LAYER_ID = 'rest-areas';
const PICK_PREFIX = 'se-rest-area:';
const OUTLINE_COLOR = '#ffffff';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** The legend rows, in the order the statuses matter. */
const STATUSES = Object.freeze([
  Object.freeze({ id: 'lorry', label: msg('Open, with lorry spaces') }),
  Object.freeze({ id: 'open', label: msg('Open, cars only') }),
  Object.freeze({ id: 'limited', label: msg('Partly closed') }),
  Object.freeze({ id: 'closed', label: msg('Closed') }),
]);

/**
 * Own one Swedish rest area display: Trafikverket's rest areas as dots,
 * amber where lorries have spaces, with click-to-card selection listing the
 * spaces and equipment. Share links carry it as token 13.
 */
export function createRestAreasLayer({
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
    throw new TypeError('Rest areas require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
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
  let _areas = [];
  /** Only the areas with lorry spaces, for drivers of heavy vehicles. */
  let _lorriesOnly = false;
  const _areaById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(REST_AREAS_LAYER_ID);
  const shown = () =>
    _lorriesOnly ? _areas.filter((row) => row.spaces.lorry > 0) : _areas;

  /** An area's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: row.status === 'closed' ? 7 : 10,
    color: statusColor(row.status),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 2,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _areaById.get(_selectedId) : null;
    if (!row || !_drawn.has(row.id)) {
      _selectedId = null;
      overlayHost.setEntries(
        REST_AREAS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildRestAreaCard(row);
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    overlayHost.setEntries(
      REST_AREAS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedArea(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _areaById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      REST_AREAS_LAYER_ID,
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
      const hit = pickedArea(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      // Another layer's item, or the bare ground: one card at a time.
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
    picking?.unregisterPickOwner?.(REST_AREAS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(REST_AREAS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(REST_AREAS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids
      .filter((id) => _drawn.has(id))
      .map((id) => _areaById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    const rows = shown();
    _dots.set(rows.map(dotOf));
    _drawn = new Set(rows.map((row) => row.id));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: REST_AREAS_LAYER_ID,
    name: 'Rest areas (Sweden)',
    icon: '🅿️',
    source: 'Trafikverket',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Rest areas layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: REST_AREAS_LAYER_ID,
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
      overlayHost?.setVisible?.(REST_AREAS_OVERLAY_SOURCE_ID, true);
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
        const signature = JSON.stringify(
          snapshot.areas.map((row) => [
            row.id,
            row.name,
            row.status,
            row.spaces,
            row.equipment,
            row.accessibleToilet,
            row.free,
            row.note,
          ]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          _areas = snapshot.areas;
          _areaById.clear();
          for (const row of _areas) _areaById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_areas);
          try {
            render();
          } catch (e) {
            console.warn('[Data:RestAreas] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Rest areas unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(`[Data:RestAreas] Updated: ${_areas.length} areas`);
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_areas);
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:RestAreas] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Rest areas unavailable');
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
      _areaById.clear();
      _areas = [];
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
      const rows = shown();
      const legend = STATUSES.map((entry) => ({
        label: t(entry.label),
        color: statusColor(entry.id),
        count: rows.filter((row) => row.status === entry.id).length,
      })).filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'lorries',
            label: t('LORRY SPACES'),
            active: _lorriesOnly,
            title: t('Show only the rest areas with spaces for lorries'),
            onClick: () => {
              _lorriesOnly = !_lorriesOnly;
              render();
              _rowListener?.();
            },
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are Trafikverket’s rest areas, with their spaces and equipment. The spaces are how many there are, not how many are free now. Click an area for its card.',
                ),
              }
            : item,
        ),
      };
    },

    /** The areas shown, for the context panel's count in view and the analyst. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      return shown()
        .slice(0, Math.max(1, maxCount))
        .map((row) => ({
          id: row.id,
          name: t('Rest area · {name}', { name: row.name }),
          lat: row.point[1],
          lon: row.point[0],
          carSpaces: row.spaces.car,
          lorrySpaces: row.spaces.lorry,
        }));
    },

    /** What a picked rest area is called, and where it is. */
    findByQuery(pickId) {
      const id = pickedArea(pickId);
      if (!id) return null;
      const row = _areaById.get(id);
      return {
        name: t('Rest area · {name}', { name: row.name }),
        latitude: row.point[1],
        longitude: row.point[0],
      };
    },

    getStats() {
      return {
        count: shown().length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
