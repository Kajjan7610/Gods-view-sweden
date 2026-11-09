import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  CAMERA_COLOR,
  SPEED_CAMERAS_OVERLAY_SOURCE_ID,
  buildSpeedCameraCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSpeedCamerasSource } from './source.js';

const PICK_PREFIX = 'se-speed-camera:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** The arrows show within this camera distance; Sweden whole is a blur. */
const SHOW_WITHIN_M = 400_000;

/** One arrow on a dark disc, drawn once and shared by every site. */
let arrowImage = null;
function arrow() {
  if (arrowImage || typeof document === 'undefined') return arrowImage;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(4, 16, 26, 0.9)';
  ctx.beginPath();
  ctx.arc(16, 16, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = CAMERA_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = CAMERA_COLOR;
  ctx.beginPath();
  ctx.moveTo(16, 6);
  ctx.lineTo(23, 22);
  ctx.lineTo(16, 18);
  ctx.lineTo(9, 22);
  ctx.closePath();
  ctx.fill();
  arrowImage = canvas;
  return arrowImage;
}

/**
 * Own one Swedish speed camera display: Trafikverket's fixed traffic safety
 * camera sites as arrows facing the camera's direction, shown when the view
 * is within reach, with click-to-card selection. Share links carry it as
 * token 0n.
 */
export function createSpeedCamerasLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Speed cameras require a snapshot source');
  // With ground heights the arrows clamp to terrain only (see groundHeights.js).
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
  let _cameras = [];
  const _cameraById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!overlayHost) return;
    const row = _selectedId ? _cameraById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        SPEED_CAMERAS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildSpeedCameraCard(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SPEED_CAMERAS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedCamera(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _cameraById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SPEED_CAMERAS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedCamera(picked) : null;
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
    overlayHost.clearSource(SPEED_CAMERAS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(SPEED_CAMERAS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const image = arrow();
    const show = new Cesium.DistanceDisplayCondition(0, SHOW_WITHIN_M);
    const scale = new Cesium.NearFarScalar(2_000, 1, SHOW_WITHIN_M, 0.45);
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of _cameras) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          billboard: {
            image,
            width: 24,
            height: 24,
            // Turned clockwise from north by the camera's bearing.
            rotation: Number.isFinite(row.bearing)
              ? -Cesium.Math.toRadians(row.bearing)
              : 0,
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: show,
            scaleByDistance: scale,
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'speed-cameras',
    name: 'Speed Cameras (Sweden)',
    icon: '📷',
    source: 'Trafikverket',
    // The sites change rarely; the proxy keeps them a day.
    updateInterval: 3_600_000,

    init(viewer) {
      if (_viewer) throw new Error('Speed camera layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('speed-cameras');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SPEED_CAMERAS_OVERLAY_SOURCE_ID, true);
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
        const signature = JSON.stringify(
          snapshot.cameras.map((row) => [row.id, row.point, row.bearing]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _cameras = snapshot.cameras;
          _cameraById.clear();
          for (const row of _cameras) _cameraById.set(row.id, row);
          render();
          console.log(
            `[Data:SpeedCameras] Updated: ${_cameras.length} camera sites`,
          );
        }
        _ground.place(_cameras);
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SpeedCameras] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Speed camera data unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /**
     * Show one site's card (the city dossier's nearest cameras); true when
     * the site is known.
     */
    selectById(id) {
      if (!_cameraById.has(String(id))) return false;
      _selectedId = String(id);
      publishSelectedCard();
      _viewer?.scene?.requestRender?.();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _ground.clear();
      _cameraById.clear();
      _cameras = [];
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
      if (!_cameras.length) return { chips: [], legend: [] };
      return {
        chips: [],
        legend: [
          {
            label: t('Camera site, arrow in the direction it faces'),
            color: CAMERA_COLOR,
            count: _cameras.length,
            blurb: t(
              'Trafikverket’s fixed traffic safety cameras: the sites where speed is checked by camera. The police move the camera equipment between sites, so not every site photographs all the time. The arrows show when the view is within about 400 km. Click a site for its road and direction.',
            ),
          },
        ],
      };
    },

    getStats() {
      return {
        count: _cameras.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
