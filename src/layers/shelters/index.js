import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { SHELTER_STATES, shelterColor } from './records.js';
import {
  SHELTERS_OVERLAY_SOURCE_ID,
  buildShelterCard,
  formatShelterDistance,
  placesText,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSheltersSource } from './source.js';

const PICK_PREFIX = 'se-shelter:';
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
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Shelters require a snapshot source');
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
  let _selectedCardId = null;
  let _shown = [];
  const _shelterById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _shelterById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(SHELTERS_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = buildShelterCard(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SHELTERS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedShelter(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _shelterById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        {
          sourceId: SHELTERS_OVERLAY_SOURCE_ID,
        },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedShelter(picked) : null;
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

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(SHELTERS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(SHELTERS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      // Farthest first, so the nearest draw on top where dots meet.
      for (const row of [..._shown].reverse()) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: pixelSize(row),
            color: Cesium.Color.fromCssColorString(shelterColor(row)),
            outlineColor: Cesium.Color.fromCssColorString('#0b1a1a'),
            outlineWidth: 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(500, 1.3, 40000, 0.7),
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  /** The view as a box and its centre, or null when the camera is too high. */
  function viewQuery() {
    const camera = _viewer?.camera;
    const height = camera?.positionCartographic?.height;
    if (!Number.isFinite(height) || height > SHELTERS_MAX_HEIGHT_M) return null;
    const rect = camera.computeViewRectangle?.(Cesium.Ellipsoid.WGS84);
    if (!rect) return null;
    const deg = Cesium.Math.toDegrees;
    const canvas = _viewer.scene.canvas;
    const middle = camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      Cesium.Ellipsoid.WGS84,
    );
    const centre = middle
      ? Cesium.Cartographic.fromCartesian(middle)
      : camera.positionCartographic;
    return {
      bbox: [deg(rect.west), deg(rect.south), deg(rect.east), deg(rect.north)],
      center: [deg(centre.longitude), deg(centre.latitude)],
    };
  }

  async function refresh() {
    if (!_enabled || !_dataSource) return false;
    _request?.abort();
    const query = viewQuery();
    if (!query) {
      _request = null;
      _zoomIn = true;
      _shown = [];
      _total = null;
      _places = null;
      _shelterById.clear();
      _ground.cancel();
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
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
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
      render();
      _ground.place(_shown);
      _rowListener?.();
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
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
    id: 'shelters',
    name: 'Shelters (Sweden)',
    icon: '🛡️',
    source: 'MCF',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Shelters layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('shelters');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SHELTERS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      _removeMove ??=
        _viewer?.camera?.moveEnd?.addEventListener?.(scheduleRefresh) ?? null;
    },

    disable() {
      _request?.abort();
      _request = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _ground.cancel();
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      _clickHandler?.destroy();
      _clickHandler = null;
      clearOverlays();
    },

    update() {
      return refresh();
    },

    /** Select a shelter in the view and fly to it (the row's nearest list). */
    setParams(params = {}) {
      const row = params.shelterId
        ? _shelterById.get(String(params.shelterId))
        : null;
      if (!row || !_viewer) return false;
      _selectedId = row.id;
      publishSelectedCard();
      if (params.focus) {
        const [lon, lat] = row.point;
        _viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.006, 650),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-50),
            roll: 0,
          },
          duration: 1.6,
        });
      }
      _rowListener?.();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _ground.clear();
      _shelterById.clear();
      _shown = [];
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
