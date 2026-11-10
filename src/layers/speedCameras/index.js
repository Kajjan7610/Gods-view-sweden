import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
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

/**
 * The two markers on a dark disc, each drawn once and shared by every site
 * it fits: an arrow for a site with a direction, a dot for one without.
 */
const markerImages = { arrow: null, dot: null };
function marker(kind) {
  if (markerImages[kind] || typeof document === 'undefined')
    return markerImages[kind];
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
  if (kind === 'arrow') {
    ctx.moveTo(16, 6);
    ctx.lineTo(23, 22);
    ctx.lineTo(16, 18);
    ctx.lineTo(9, 22);
    ctx.closePath();
  } else {
    ctx.arc(16, 16, 4.5, 0, Math.PI * 2);
  }
  ctx.fill();
  markerImages[kind] = canvas;
  return canvas;
}

/**
 * Own one Swedish speed camera display: Trafikverket's fixed traffic safety
 * camera sites as arrows facing the camera's direction (a dot where none is
 * given), shown when the view is within reach, with click-to-card selection.
 * Share links carry it as token 0n.
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
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
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
  let _moveEndRemove = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _cameras = [];
  let _withoutDirection = 0;
  const _cameraById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!overlayHost) return;
    const row = _selectedId ? _cameraById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        SPEED_CAMERAS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildSpeedCameraCard(row);
    card.position = position(row);
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
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(click.position?.x, click.position?.y)) return;
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

  /**
   * After a camera move: the card of a site whose marker the move put out of
   * reach goes with it. Nothing to do without a selected site.
   */
  function dropCardOutOfReach() {
    if (!_selectedId) return;
    const row = _cameraById.get(_selectedId);
    const eye = _viewer?.camera?.positionWC;
    if (!row || !eye) return;
    if (Cesium.Cartesian3.distance(eye, position(row)) <= SHOW_WITHIN_M) return;
    _selectedId = null;
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(SPEED_CAMERAS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(SPEED_CAMERAS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dataSource) return;
    liftEntities(
      _dataSource.entities,
      ids,
      (id) => `${PICK_PREFIX}${id}`,
      (id) => {
        const row = _cameraById.get(id);
        return row && position(row);
      },
    );
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const arrow = marker('arrow');
    const dot = marker('dot');
    const show = new Cesium.DistanceDisplayCondition(0, SHOW_WITHIN_M);
    const scale = new Cesium.NearFarScalar(2_000, 1, SHOW_WITHIN_M, 0.45);
    redrawEntities(entities, () => {
      for (const row of _cameras) {
        const facing = Number.isFinite(row.bearing);
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          billboard: {
            // No direction is no arrow: an arrow would point north.
            image: facing ? arrow : dot,
            width: 24,
            height: 24,
            // Turned clockwise from north by the camera's bearing.
            rotation: facing ? -Cesium.Math.toRadians(row.bearing) : 0,
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
    });
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
      _moveEndRemove ??=
        _viewer?.camera?.moveEnd?.addEventListener?.(dropCardOutOfReach) ??
        null;
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      _moveEndRemove?.();
      _moveEndRemove = null;
      // Switched on again it starts without the last round's failure.
      _lastError = null;
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
        // The whole rows: a new name, road or county shows on the card too.
        const signature = JSON.stringify(snapshot.cameras);
        if (signature !== _signature) {
          // Once drawn the signature is kept; a drawing that failed is not,
          // so the next round makes it again.
          _signature = null;
          _cameraById.clear();
          for (const row of snapshot.cameras) _cameraById.set(row.id, row);
          // One marker per id, whatever the answer repeats.
          _cameras = [..._cameraById.values()];
          _withoutDirection = _cameras.filter(
            (row) => !Number.isFinite(row.bearing),
          ).length;
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_cameras);
          render();
          _signature = signature;
          console.log(
            `[Data:SpeedCameras] Updated: ${_cameras.length} camera sites`,
          );
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_cameras);
        }
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
      _withoutDirection = 0;
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
            count: _cameras.length - _withoutDirection,
            blurb: t(
              'Trafikverket’s fixed traffic safety cameras: the sites where speed is checked by camera. The police move the camera equipment between sites, so not every site photographs all the time. The arrows show when the view is within about 400 km. Click a site for its road and direction.',
            ),
          },
          ...(_withoutDirection
            ? [
                {
                  label: t('Camera site, direction not given'),
                  color: CAMERA_COLOR,
                  count: _withoutDirection,
                  blurb: t(
                    'Sites where Trafikverket gives no direction, or gives 0 degrees, which mostly stands for none. They are drawn as a dot without an arrow.',
                  ),
                },
              ]
            : []),
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
