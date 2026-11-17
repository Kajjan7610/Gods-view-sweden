import { msg, t } from '../../i18n/index.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import {
  ED_BANDS,
  ED_METRICS,
  HOSPITAL_COLOR,
  NO_FIGURE_COLOR,
  distanceMeters,
  edBand,
  edMinutes,
  hospitalColor,
  nationalMinutes,
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

export const HOSPITALS_LAYER_ID = 'hospitals';
const PICK_PREFIX = 'se-hospital:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MOVE_SETTLE_MS = 400;
const LISTED = 5;
const OUTLINE_COLOR = '#3b0d0d';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 2e4,
  nearValue: 1.3,
  far: 2e6,
  farValue: 0.7,
});
/** The look of a flight to a hospital: from the south, 45° down. */
const FOCUS_PITCH = -45 * (Math.PI / 180);

/** A hospital on the ground: its bundled height above the ellipsoid, else 0. */
const hospitalPosition = (row) => ({
  lon: row.point[0],
  lat: row.point[1],
  height: row.height ?? 0,
});

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
  picking = null,
  pointer = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Hospitals require a snapshot source');
  let _viewer = null;
  let _dots = null;
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
  let _hospitals = [];
  // The snapshot's statistics: their year, Sweden's medians, when published.
  let _statistics = {};
  let _metric = 'ttl';
  let _order = 'nearest';
  let _view = null;
  const _hospitalById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(HOSPITALS_LAYER_ID);

  /** A hospital's dot as the set draws it, in the metric shown. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: hospitalPosition(row),
    height: 'clampGround',
    pixelSize: row.ed ? 11 : 7,
    color: hospitalColor(row, _metric, _statistics),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: row.ed ? 2 : 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _hospitalById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
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
      { metric: _metric, statistics: _statistics },
    );
    card.position = fromDegrees(row.point[0], row.point[1], row.height ?? 0);
    overlayHost.setEntries(
      HOSPITALS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedHospital(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _hospitalById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      HOSPITALS_LAYER_ID,
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
      const hit = pickedHospital(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        _rowListener?.();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(HOSPITALS_LAYER_ID, pickId))
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
    picking?.unregisterPickOwner?.(HOSPITALS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(HOSPITALS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(HOSPITALS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dots) return;
    // Departments last, so they draw on top of the hospitals around them.
    const ordered = [..._hospitals].sort(
      (a, b) => Number(Boolean(a.ed)) - Number(Boolean(b.ed)),
    );
    _dots.set(ordered.map(dotOf));
    publishSelectedCard();
    requestRender();
  }

  /** The ground under the canvas centre, in degrees, or null. */
  function viewCentre() {
    const query = findQuery(_viewer);
    const canvas = canvasOf(_viewer);
    if (typeof query?.pickEllipsoid !== 'function' || !canvas) return null;
    const middle = query.pickEllipsoid(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const ground = middle ? toLonLatH(middle) : null;
    return ground ? [ground.lon, ground.lat] : null;
  }

  /** The view as a box and its centre, from the camera alone. */
  function readView() {
    const camera = _viewer ? findCamera(_viewer) : null;
    const pose = camera?.pose();
    if (!pose) return null;
    const rect = camera.viewRectangle?.() ?? null;
    return {
      center: viewCentre() ?? [pose.lon, pose.lat],
      bbox: rect ? [rect.west, rect.south, rect.east, rect.north] : null,
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
    id: HOSPITALS_LAYER_ID,
    name: 'Hospitals & Emergency (Sweden)',
    icon: '🏥',
    source: 'Socialstyrelsen',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Hospitals layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: HOSPITALS_LAYER_ID,
        // Terrain only, with the bundled height (see companyStores).
        clampTo: 'terrain',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(HOSPITALS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      const camera = _viewer ? findCamera(_viewer) : null;
      if (!_removeMove && camera) {
        // A jump set from a share link or a search ends no move; `changed`
        // catches it, `moveEnd` the small pans below its threshold.
        const removers = [
          camera.on('moveEnd', followCamera),
          camera.on('changed', followCamera),
        ].filter(Boolean);
        _removeMove = () => removers.forEach((remove) => remove());
      }
      _view = readView();
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
      requestRender();
    },

    async update() {
      if (!_enabled || !_dots) return false;
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
        _statistics = snapshot.statistics ?? {};
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

    /** Select a hospital and fly to it (the row's list), while it is on. */
    setParams(params = {}) {
      if (!_enabled || !_loaded) return false;
      const row = params.hospitalId
        ? _hospitalById.get(String(params.hospitalId))
        : null;
      if (!row) return false;
      _selectedId = row.id;
      publishSelectedCard();
      if (params.focus) {
        const [lon, lat] = row.point;
        findCamera(_viewer)?.flyTo(
          { lon, lat: lat - 0.012, height: 1400 },
          {
            orientation: { heading: 0, pitch: FOCUS_PITCH, roll: 0 },
            durationS: 1.8,
          },
        );
      }
      _rowListener?.();
      return true;
    },

    destroy() {
      layer.disable();
      _hospitalById.clear();
      _hospitals = [];
      _statistics = {};
      _loaded = false;
      _view = null;
      _dots?.dispose();
      _dots = null;
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
        _hospitals.filter((row) => edBand(row, _metric, _statistics) === id)
          .length;
      const year = _statistics.year;
      const median = nationalMinutes(_metric, _statistics);
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
            (row) => row.ed && edBand(row, _metric, _statistics) === null,
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
                  'Large dots are emergency departments in Socialstyrelsen’s statistics for {year}, coloured by their median against Sweden’s ({median}): more than 15 % shorter, within 15 %, or longer. Medians are for the whole year and for adults, so they compare departments; they are not today’s wait. Small dots are other hospitals from OpenStreetMap. Life-threatening: call 112; for advice, 1177.',
                  { year, median: formatMinutes(median) },
                ),
              }
            : item,
        );
      const ranked = _view
        ? rankDepartments(_hospitals, {
            center: _view.center,
            bbox: _view.bbox,
            statistics: _statistics,
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
        info:
          median === null
            ? ''
            : t('Sweden {year}: {ttl} to physician, {tvt} in total (medians)', {
                year,
                ttl: formatMinutes(nationalMinutes('ttl', _statistics)),
                tvt: formatMinutes(nationalMinutes('tvt', _statistics)),
              }),
        infoTitle: t(
          'Socialstyrelsen, Patientregistret: emergency departments with two or more specialties at the hospital, visits by patients aged 19 and over. Published {date}.',
          { date: _statistics.published ?? '' },
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
                ? formatMinutes(edMinutes(row, _metric, _statistics))
                : formatHospitalDistance(distance),
            text: [
              row.name,
              _order === 'shortest'
                ? formatHospitalDistance(distance)
                : formatMinutes(edMinutes(row, _metric, _statistics)),
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
