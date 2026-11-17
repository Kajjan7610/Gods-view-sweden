import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { SHELTER_STATES, clipViewBox, shelterColor } from './records.js';
import {
  SHELTERS_OVERLAY_SOURCE_ID,
  buildShelterCard,
  formatShelterDistance,
  placesText,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSheltersSource } from './source.js';

export const SHELTERS_LAYER_ID = 'shelters';
const PICK_PREFIX = 'se-shelter:';
const OUTLINE_COLOR = '#0b1a1a';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 500,
  nearValue: 1.3,
  far: 40000,
  farValue: 0.7,
});
/** The flight to a shelter picked from the list: 50° down, from the south. */
const FOCUS_PITCH = (-50 * Math.PI) / 180;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Shelters show below this camera height; above it, a hint to zoom in. */
export const SHELTERS_MAX_HEIGHT_M = 40_000;
/** The nearest this many to the map centre are drawn. */
const SHOWN = 1500;
const MOVE_SETTLE_MS = 400;
const NEAREST_LISTED = 5;

/** Dot size by places: a big shelter reads larger. */
const pixelSize = (row) =>
  !row.places
    ? 6
    : row.places >= 300
      ? 11
      : row.places >= 100
        ? 9
        : row.places >= 40
          ? 8
          : 7;

/**
 * Own one Swedish shelter display: MCF's register of civil-defence shelters,
 * drawn for the view once the camera is low enough, the nearest first, with
 * click-to-card selection and a list of the nearest to the map centre.
 * Share links carry it as token 0h.
 */
export function createSheltersLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Shelters require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  // The rows follow the view, so their heights are kept apart from the fixed
  // layers' and cannot push those out of this browser's store.
  const _ground = createGroundHeights(terrain, (ids) => lift(ids), {
    passing: true,
  });
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  let _viewer = null;
  let _dots = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _zoomIn = true;
  let _total = null;
  let _places = null;
  let _count = null;
  let _selectedId = null;
  let _shown = [];
  const _shelterById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(SHELTERS_LAYER_ID);

  /** A shelter's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: pixelSize(row),
    color: shelterColor(row),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _shelterById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(SHELTERS_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = buildShelterCard(row);
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    overlayHost.setEntries(
      SHELTERS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedShelter(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _shelterById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      SHELTERS_LAYER_ID,
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
      const hit = pickedShelter(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        _rowListener?.();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SHELTERS_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
        _rowListener?.();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(SHELTERS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(SHELTERS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(SHELTERS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids.map((id) => _shelterById.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Farthest first, so the nearest draw on top where dots meet.
    _dots.set([..._shown].reverse().map(dotOf));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  /** The view as a box and its centre, or null when the camera is too high. */
  function viewQuery() {
    const camera = _viewer ? findCamera(_viewer) : null;
    const pose = camera?.pose();
    if (!Number.isFinite(pose?.height) || pose.height > SHELTERS_MAX_HEIGHT_M)
      return null;
    const rect = camera.viewRectangle?.();
    if (!rect) return null;
    const canvas = canvasOf(_viewer);
    const middle = canvas
      ? findQuery(_viewer)?.pickEllipsoid(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        )
      : null;
    const centre = (middle && toLonLatH(middle)) || pose;
    const center = [centre.lon, centre.lat];
    return {
      // A tilted view reaches the horizon: ask for the part about the centre.
      bbox: clipViewBox([rect.west, rect.south, rect.east, rect.north], center),
      center,
    };
  }

  /** Forget the view's shelters: the camera is too high, or the layer off. */
  function clearRows() {
    _zoomIn = true;
    _shown = [];
    _total = null;
    _places = null;
    _shelterById.clear();
    _ground.cancel();
  }

  async function refresh() {
    if (!_enabled || !_dots) return false;
    _request?.abort();
    const query = viewQuery();
    if (!query) {
      _request = null;
      clearRows();
      render();
      _rowListener?.();
      return true;
    }
    const request = new AbortController();
    _request = request;
    try {
      const snapshot = await source.getSnapshot({
        signal: request.signal,
        ...query,
        limit: SHOWN,
      });
      // Switched off meanwhile: not this layer's data any more. A request the
      // layer itself replaced (the camera moved on) is no failure.
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      _stale = snapshot.stale;
      _lastUpdate =
        _stale && Number.isFinite(snapshot.fetchedAt)
          ? snapshot.fetchedAt
          : Date.now();
      _lastError = null;
      _count = snapshot.count;
      _zoomIn = snapshot.tooWide;
      _shown = snapshot.tooWide ? [] : snapshot.shelters;
      _total = snapshot.total;
      _places = snapshot.places;
      _shelterById.clear();
      for (const row of _shown) _shelterById.set(row.id, row);
      if (_selectedId && !_shelterById.has(_selectedId)) {
        _selectedId = null;
        publishSelectedCard();
      }
      // Heights first: the ones this browser kept are drawn at once.
      _ground.place(_shown);
      render();
      _rowListener?.();
      return true;
    } catch (e) {
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      console.warn('[Data:Shelters] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Shelter data unavailable');
      _stale = false;
      _rowListener?.();
      return true;
    } finally {
      if (_request === request) _request = null;
    }
  }

  function scheduleRefresh() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
  }

  const layer = {
    id: SHELTERS_LAYER_ID,
    name: 'Shelters (Sweden)',
    icon: '🛡️',
    source: 'MCF',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Shelters layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: SHELTERS_LAYER_ID,
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
      overlayHost?.setVisible?.(SHELTERS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      _removeMove ??=
        (_viewer && findCamera(_viewer)?.on('moveEnd', scheduleRefresh)) ??
        null;
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      // The next enable starts from its own view, not this one's dots and list.
      clearRows();
      render();
    },

    update() {
      return refresh();
    },

    /** Select a shelter in the view and fly to it (the row's nearest list). */
    setParams(params = {}) {
      if (!_enabled) return false;
      const row = params.shelterId
        ? _shelterById.get(String(params.shelterId))
        : null;
      if (!row || !_viewer) return false;
      _selectedId = row.id;
      publishSelectedCard();
      if (params.focus) {
        const [lon, lat] = row.point;
        findCamera(_viewer)?.flyTo(
          { lon, lat: lat - 0.006, height: 650 },
          {
            orientation: { heading: 0, pitch: FOCUS_PITCH, roll: 0 },
            durationS: 1.6,
          },
        );
      }
      requestRender();
      _rowListener?.();
      return true;
    },

    destroy() {
      layer.disable();
      _ground.clear();
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
      if (_zoomIn)
        return {
          info: t('Zoom in to see shelters: they show below {height} km', {
            height: SHELTERS_MAX_HEIGHT_M / 1000,
          }),
        };
      const limited = _shown.filter((row) => row.limited).length;
      const legend = [
        {
          label: t('Shelter'),
          color: SHELTER_STATES[0].color,
          count: _shown.length - limited,
        },
        {
          label: t('Temporarily restricted'),
          color: SHELTER_STATES[1].color,
          count: limited,
        },
      ]
        .filter((item) => item.count > 0)
        .map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are the civil-defence shelters MCF registers, sized by their places; the nearest to the map centre are drawn. Shelters are for use in heightened alert, when VMA tells you to seek shelter. Click one for its property and places.',
                ),
              }
            : item,
        );
      return {
        legend,
        info:
          _total === null
            ? ''
            : tn(
                _total,
                '{count} shelter with {places} in view',
                '{count} shelters with {places} in view',
                {
                  count: formatNumber(_total),
                  places: placesText(_places || 0),
                },
              ),
        list: {
          ariaLabel: t('Nearest shelters to the map centre'),
          items: _shown.slice(0, NEAREST_LISTED).map((row, index) => ({
            id: row.id,
            ordinal: index + 1,
            lead: formatShelterDistance(row.distance),
            text: [
              row.number,
              row.property,
              row.places ? placesText(row.places) : null,
            ]
              .filter(Boolean)
              .join(' · '),
            active: row.id === _selectedId,
            params: { shelterId: row.id, focus: true },
          })),
        },
      };
    },

    getStats() {
      return {
        count: _zoomIn ? _count : _total,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
