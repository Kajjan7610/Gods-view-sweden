import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  ED_BANDS,
  ED_METRICS,
  HOSPITAL_COLOR,
  NO_FIGURE_COLOR,
  distanceMeters,
  edBand,
  edMinutes,
  hospitalColor,
  rankDepartments,
} from './records.js';
import {
  HOSPITALS_OVERLAY_SOURCE_ID,
  buildHospitalCard,
  formatHospitalDistance,
  formatMinutes,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createHospitalsSource } from './source.js';

const PICK_PREFIX = 'se-hospital:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MOVE_SETTLE_MS = 400;
const LISTED = 5;

/** A hospital on the ground: its bundled height above the ellipsoid, else 0. */
const hospitalPosition = (row) =>
  Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1], row.height ?? 0);

/**
 * Own one Swedish hospital display: the hospitals in an OpenStreetMap
 * snapshot, the ones with an emergency department in Socialstyrelsen's yearly
 * statistics coloured by their median time to physician or total stay
 * against the national median, with a list of the nearest departments to the
 * map centre or the shortest in view, and click-to-card selection. Nothing
 * is fetched after the one bundled read: the list follows the camera from
 * memory. Share links carry it as token 0g.
 */
export function createHospitalsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Hospitals require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _loaded = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _hospitals = [];
  let _national = {};
  let _metric = 'ttl';
  let _order = 'nearest';
  let _view = null;
  const _hospitalById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _hospitalById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        HOSPITALS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildHospitalCard(
      _view
        ? {
            ...row,
            distance: Math.round(distanceMeters(_view.center, row.point)),
          }
        : row,
      { metric: _metric, national: _national },
    );
    card.position = hospitalPosition(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      HOSPITALS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedHospital(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _hospitalById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: HOSPITALS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedHospital(picked) : null;
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        _rowListener?.();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        _rowListener?.();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(HOSPITALS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(HOSPITALS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      // Departments last, so they draw on top of the hospitals around them.
      const ordered = [..._hospitals].sort(
        (a, b) => Number(Boolean(a.ed)) - Number(Boolean(b.ed)),
      );
      for (const row of ordered) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: hospitalPosition(row),
          point: {
            pixelSize: row.ed ? 11 : 7,
            color: Cesium.Color.fromCssColorString(
              hospitalColor(row, _metric, _national),
            ),
            outlineColor: Cesium.Color.fromCssColorString('#3b0d0d'),
            outlineWidth: row.ed ? 2 : 1.5,
            // Terrain only, with the bundled height (see companyStores).
            heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.3, 2e6, 0.7),
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  /** The view as a box and its centre, from the camera alone. */
  function readView() {
    const camera = _viewer?.camera;
    if (!camera?.positionCartographic) return null;
    const deg = Cesium.Math.toDegrees;
    const canvas = _viewer.scene.canvas;
    const middle = camera.pickEllipsoid?.(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      Cesium.Ellipsoid.WGS84,
    );
    const centre = middle
      ? Cesium.Cartographic.fromCartesian(middle)
      : camera.positionCartographic;
    const rect = camera.computeViewRectangle?.(Cesium.Ellipsoid.WGS84);
    return {
      center: [deg(centre.longitude), deg(centre.latitude)],
      bbox: rect
        ? [deg(rect.west), deg(rect.south), deg(rect.east), deg(rect.north)]
        : null,
    };
  }

  function followCamera() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      if (!_enabled) return;
      _view = readView();
      if (_selectedId) publishSelectedCard();
      _rowListener?.();
    }, MOVE_SETTLE_MS);
  }

  const layer = {
    id: 'hospitals',
    name: 'Hospitals & Emergency (Sweden)',
    icon: '🏥',
    source: 'Socialstyrelsen',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Hospitals layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('hospitals');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(HOSPITALS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      if (!_removeMove && _viewer?.camera) {
        // A jump set from a share link or a search ends no move; `changed`
        // catches it, `moveEnd` the small pans below its threshold.
        const removers = [
          _viewer.camera.moveEnd?.addEventListener?.(followCamera),
          _viewer.camera.changed?.addEventListener?.(followCamera),
        ].filter(Boolean);
        _removeMove = () => removers.forEach((remove) => remove());
      }
      _view = readView();
    },

    disable() {
      _request?.abort();
      _request = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      _clickHandler?.destroy();
      _clickHandler = null;
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      // The snapshot is bundled; one read per session is enough.
      if (_loaded) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _hospitals = snapshot.hospitals;
        _national = snapshot.national;
        _hospitalById.clear();
        for (const row of _hospitals) _hospitalById.set(row.id, row);
        _loaded = true;
        _lastUpdate = snapshot.osmBase ? Date.parse(snapshot.osmBase) : null;
        _lastError = null;
        _view = readView();
        render();
        console.log(`[Data:Hospitals] Loaded: ${_hospitals.length} hospitals`);
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Hospitals] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Hospital data unavailable');
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Select a hospital and fly to it (the row's list). */
    setParams(params = {}) {
      const row = params.hospitalId
        ? _hospitalById.get(String(params.hospitalId))
        : null;
      if (!row || !_viewer) return false;
      _selectedId = row.id;
      publishSelectedCard();
      if (params.focus) {
        const [lon, lat] = row.point;
        _viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.012, 1400),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-45),
            roll: 0,
          },
          duration: 1.8,
        });
      }
      _rowListener?.();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _hospitalById.clear();
      _hospitals = [];
      _national = {};
      _loaded = false;
      _view = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      if (!_loaded) return {};
      const bandCount = (id) =>
        _hospitals.filter((row) => edBand(row, _metric, _national) === id)
          .length;
      const median = _national[`${_metric}2025`];
      const bandLabels = {
        shorter: t('Shorter than Sweden’s median'),
        near: t('Near Sweden’s median'),
        longer: t('Longer than Sweden’s median'),
      };
      const legend = [
        ...ED_BANDS.map((band) => ({
          label: bandLabels[band.id],
          color: band.color,
          count: bandCount(band.id),
        })),
        {
          label: t('Emergency department without this figure'),
          color: NO_FIGURE_COLOR,
          count: _hospitals.filter(
            (row) => row.ed && edBand(row, _metric, _national) === null,
          ).length,
        },
        {
          label: t('Hospital outside the statistics'),
          color: HOSPITAL_COLOR,
          count: _hospitals.filter((row) => !row.ed).length,
        },
      ]
        .filter((item) => item.count > 0)
        .map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Large dots are emergency departments in Socialstyrelsen’s statistics for 2025, coloured by their median against Sweden’s ({median}): more than 15 % shorter, within 15 %, or longer. Medians are for the whole year and for adults, so they compare departments; they are not today’s wait. Small dots are other hospitals from OpenStreetMap. Life-threatening: call 112; for advice, 1177.',
                  { median: formatMinutes(median) },
                ),
              }
            : item,
        );
      const ranked = _view
        ? rankDepartments(_hospitals, {
            center: _view.center,
            bbox: _view.bbox,
            metric: _metric,
            order: _order,
            limit: LISTED,
          })
        : [];
      return {
        segmented: {
          id: 'hospitals-metric',
          ariaLabel: t('What colours the emergency departments'),
          options: ED_METRICS.map((option) => ({
            id: `metric-${option.id}`,
            label: t(option.label),
            active: _metric === option.id,
            onClick: () => {
              _metric = option.id;
              render();
              _rowListener?.();
            },
          })),
        },
        chips: [
          {
            id: 'hospitals-shortest',
            label: t('Shortest in view'),
            active: _order === 'shortest',
            title: t(
              'List the emergency departments in view with the shortest median first, instead of the nearest',
            ),
            onClick: () => {
              _order = _order === 'shortest' ? 'nearest' : 'shortest';
              _rowListener?.();
            },
          },
        ],
        legend,
        info: Number.isFinite(median)
          ? t('Sweden 2025: {ttl} to physician, {tvt} in total (medians)', {
              ttl: formatMinutes(_national.ttl2025),
              tvt: formatMinutes(_national.tvt2025),
            })
          : '',
        infoTitle: t(
          'Socialstyrelsen, Patientregistret: emergency departments with two or more specialties at the hospital, visits by patients aged 19 and over. Published {date}.',
          { date: '2026-05-25' },
        ),
        list: {
          ariaLabel:
            _order === 'shortest'
              ? t('Emergency departments in view, shortest median first')
              : t('Nearest emergency departments to the map centre'),
          items: ranked.map(({ row, distance }, index) => ({
            id: row.id,
            ordinal: index + 1,
            lead:
              _order === 'shortest'
                ? formatMinutes(edMinutes(row, _metric))
                : formatHospitalDistance(distance),
            text: [
              row.name,
              _order === 'shortest'
                ? formatHospitalDistance(distance)
                : formatMinutes(edMinutes(row, _metric)),
            ]
              .filter(Boolean)
              .join(' · '),
            active: row.id === _selectedId,
            params: { hospitalId: row.id, focus: true },
          })),
        },
      };
    },

    getStats() {
      return {
        count: _hospitals.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
