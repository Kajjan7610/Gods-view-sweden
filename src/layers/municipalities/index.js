import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  BOUNDARY_KINDS,
  areaAt,
  decodeLine,
  indexAreas,
  ringPoints,
} from './records.js';
import {
  MUNICIPALITIES_OVERLAY_SOURCE_ID,
  MUNICIPALITY_LABELS_SOURCE_ID,
  buildMunicipalityCard,
  formatPopulationDate,
  populationText,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createMunicipalitiesSource } from './source.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 40,
  collisionCapacity: 40,
  moving: false,
});
/** Above this camera height the counties are named, below it the municipalities. */
const COUNTY_NAMES_ABOVE_M = 250_000;
const LABELS_SHOWN = 40;
const MOVE_SETTLE_MS = 400;

/**
 * Lines on the ground for the surface the map shows: the globe's terrain,
 * or the photorealistic 3D tiles when the globe is hidden (see
 * submarineCables/surface.js, which draws its cables the same way).
 */
function classificationFor(scene) {
  if (!scene?.globe) return Cesium.ClassificationType.BOTH;
  return scene.globe.show === false
    ? Cesium.ClassificationType.CESIUM_3D_TILE
    : Cesium.ClassificationType.TERRAIN;
}

const groundPositions = (points) =>
  Cesium.Cartesian3.fromDegreesArray(points.flat());

/**
 * Own one Swedish boundary display: the 290 municipalities and 21 counties
 * from an OpenStreetMap snapshot as lines on the ground (county lines
 * thicker, sea boundaries left out), their names as labels for the view, the
 * municipality at the map centre in the row and a card with SCB's newest
 * population for a clicked municipality. Nothing is fetched after the one
 * bundled read. Share links carry it as token 0f.
 */
export function createMunicipalitiesLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  mapStackEventTarget = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Municipalities require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  // The selected municipality's outline, apart from the lines, so selecting
  // one never rebuilds the batched border lines.
  let _highlight = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _stackListener = null;
  let _loaded = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _snapshot = null;
  let _lines = [];
  let _municipalityIndex = [];
  let _countyByCode = new Map();
  let _selected = null;
  let _centre = null;
  let _view = null;
  const _shown = new Set(BOUNDARY_KINDS.map((kind) => kind.id));

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const labelPosition = (area) =>
    Cesium.Cartesian3.fromDegrees(area.label[0], area.label[1], 0);

  function publishSelectedCard() {
    if (!canSelect()) return;
    if (!_selected) {
      overlayHost.setEntries(
        MUNICIPALITIES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildMunicipalityCard(_selected, {
      county: _countyByCode.get(_selected.county) ?? null,
      populationPeriod: _snapshot?.populationPeriod,
    });
    card.position = labelPosition(_selected);
    overlayHost.setEntries(
      MUNICIPALITIES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Names for the view: counties from high up, municipalities lower down. */
  function publishLabels() {
    if (!overlayHost) return;
    const height = _viewer?.camera?.positionCartographic?.height;
    const counties = !(height < COUNTY_NAMES_ABOVE_M);
    const kind = counties ? 'county' : 'municipality';
    const areas =
      _enabled && _loaded && _view && _shown.has(kind)
        ? counties
          ? _snapshot.counties
          : _snapshot.municipalities
        : [];
    const [west, south, east, north] = _view?.bbox ?? [-180, -90, 180, 90];
    const centre = _view?.center ?? [0, 0];
    const cos = Math.cos((centre[1] * Math.PI) / 180);
    const entries = areas
      .filter(
        ({ label: [lon, lat] }) =>
          lon >= west && lon <= east && lat >= south && lat <= north,
      )
      .map((area) => ({
        area,
        d:
          ((area.label[0] - centre[0]) * cos) ** 2 +
          (area.label[1] - centre[1]) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LABELS_SHOWN)
      .filter(({ area }) => area !== _selected)
      .map(({ area }, index) => ({
        id: `municipality-label:${kind}:${area.code}`,
        position: labelPosition(area),
        variant: 'label',
        title: area.name,
        accent: BOUNDARY_KINDS.find((entry) => entry.id === kind).color,
        priority: 900 - index,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 0,
        verticalOnly: true,
        placement: 'above',
      }));
    overlayHost.setEntries(
      MUNICIPALITY_LABELS_SOURCE_ID,
      entries,
      LABEL_HOST_OPTIONS,
    );
  }

  function clearOverlays() {
    if (!overlayHost) return;
    for (const id of [
      MUNICIPALITIES_OVERLAY_SOURCE_ID,
      MUNICIPALITY_LABELS_SOURCE_ID,
    ]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function render() {
    if (!_dataSource) return;
    const classificationType = classificationFor(_viewer?.scene);
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      // Municipal lines first, so county lines draw over them.
      for (const kind of [...BOUNDARY_KINDS].reverse()) {
        if (!_shown.has(kind.id)) continue;
        const code = kind.id === 'county' ? 'c' : 'm';
        const material = Cesium.Color.fromCssColorString(kind.color).withAlpha(
          0.85,
        );
        _lines.forEach((points, index) => {
          const line = _snapshot.lines[index];
          if (line.s || line.k !== code || points.length < 2) return;
          entities.add({
            polyline: {
              positions: groundPositions(points),
              width: kind.width,
              material,
              clampToGround: true,
              classificationType,
            },
          });
        });
      }
    } finally {
      entities.resumeEvents();
    }
    renderSelection();
  }

  function renderSelection() {
    if (!_highlight) return;
    const classificationType = classificationFor(_viewer?.scene);
    const entities = _highlight.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      if (_selected)
        for (const ring of _selected.rings)
          entities.add({
            polyline: {
              positions: groundPositions(ringPoints(ring, _lines)),
              width: 4,
              material: Cesium.Color.WHITE.withAlpha(0.9),
              clampToGround: true,
              classificationType,
            },
          });
    } finally {
      entities.resumeEvents();
    }
    publishSelectedCard();
    publishLabels();
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
      if (!_enabled || !_loaded) return;
      _view = readView();
      _centre = _view ? areaAt(_municipalityIndex, _view.center) : null;
      publishLabels();
      _rowListener?.();
    }, MOVE_SETTLE_MS);
  }

  function select(municipality) {
    if (municipality === _selected) return;
    _selected = municipality;
    renderSelection();
    _rowListener?.();
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_loaded || (pointer && !pointer.isPointerFree())) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: MUNICIPALITIES_OVERLAY_SOURCE_ID },
      );
      if (cardHit) return;
      // Another layer's object under the click is that layer's to select.
      const picked = _viewer.scene.pick(click.position);
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      const point = _viewer.camera.pickEllipsoid(
        click.position,
        Cesium.Ellipsoid.WGS84,
      );
      if (!point) return;
      const where = Cesium.Cartographic.fromCartesian(point);
      const hit = areaAt(_municipalityIndex, [
        Cesium.Math.toDegrees(where.longitude),
        Cesium.Math.toDegrees(where.latitude),
      ]);
      select(hit && hit !== _selected ? hit : null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'municipalities',
    name: 'Municipalities & Counties (Sweden)',
    icon: '🗺️',
    source: 'SCB',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Municipalities layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('municipalities');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _highlight = new Cesium.CustomDataSource('municipality-selected');
      _highlight.show = false;
      viewer.dataSources.add(_highlight);
      if (mapStackEventTarget?.addEventListener) {
        // Switching between the globe and 3D tiles moves the lines' surface.
        _stackListener = () => {
          if (_loaded) render();
        };
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          _stackListener,
        );
      }
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (_highlight) _highlight.show = true;
      for (const id of [
        MUNICIPALITIES_OVERLAY_SOURCE_ID,
        MUNICIPALITY_LABELS_SOURCE_ID,
      ])
        overlayHost?.setVisible?.(id, true);
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
      if (_loaded) followCamera();
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
      if (_highlight) _highlight.show = false;
      _clickHandler?.destroy();
      _clickHandler = null;
      if (_selected) {
        _selected = null;
        renderSelection();
      }
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
        _snapshot = snapshot;
        _lines = snapshot.lines.map((line) => decodeLine(line.p));
        _municipalityIndex = indexAreas(snapshot.municipalities, _lines);
        _countyByCode = new Map(
          snapshot.counties.map((county) => [county.code, county]),
        );
        _loaded = true;
        _lastUpdate = snapshot.osmBase ? Date.parse(snapshot.osmBase) : null;
        _lastError = null;
        _view = readView();
        _centre = _view ? areaAt(_municipalityIndex, _view.center) : null;
        render();
        console.log(
          `[Data:Municipalities] Loaded: ${snapshot.municipalities.length} municipalities, ${snapshot.counties.length} counties`,
        );
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Municipalities] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Boundary data unavailable');
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Select a municipality by its code and fly over it. */
    setParams(params = {}) {
      const municipality = _snapshot?.municipalities.find(
        (entry) => entry.code === String(params.municipalityCode ?? ''),
      );
      if (!municipality || !_viewer) return false;
      select(municipality);
      if (params.focus) {
        const [lon, lat] = municipality.label;
        _viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 60_000),
          duration: 1.8,
        });
      }
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_stackListener)
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          _stackListener,
        );
      _stackListener = null;
      _snapshot = null;
      _lines = [];
      _municipalityIndex = [];
      _countyByCode = new Map();
      _loaded = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      if (_highlight) {
        viewer.dataSources.remove(_highlight, true);
        _highlight = null;
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
      const labels = {
        county: t('County border'),
        municipality: t('Municipal border'),
      };
      const date = formatPopulationDate(_snapshot.populationPeriod);
      const centre = _centre;
      const county = centre ? _countyByCode.get(centre.county) : null;
      return {
        chips: BOUNDARY_KINDS.map((kind) => ({
          id: `boundary-${kind.id}`,
          label: kind.id === 'county' ? t('Counties') : t('Municipalities'),
          active: _shown.has(kind.id),
          title:
            kind.id === 'county'
              ? t('Show or hide county borders')
              : t('Show or hide municipal borders'),
          onClick: () => {
            if (_shown.has(kind.id)) _shown.delete(kind.id);
            else _shown.add(kind.id);
            render();
            _rowListener?.();
          },
        })),
        legend: BOUNDARY_KINDS.filter((kind) => _shown.has(kind.id)).map(
          (kind, index) => ({
            label: labels[kind.id],
            color: kind.color,
            ...(index === 0
              ? {
                  blurb: t(
                    'Lines are the borders of Sweden’s 290 municipalities and 21 counties from OpenStreetMap; borders at sea are left out. Names follow the view: counties from high up, municipalities closer in. Click a municipality for its county and SCB’s newest population with the change over a year.',
                  ),
                }
              : {}),
          }),
        ),
        info: centre
          ? t('Map centre: {municipality}, {county} · {population}', {
              municipality: centre.name,
              county: county?.name ?? '',
              population: populationText(centre),
            })
          : '',
        infoTitle: date ? t('Population on {date} (SCB)', { date }) : '',
      };
    },

    getStats() {
      return {
        count: _snapshot?.municipalities.length ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
