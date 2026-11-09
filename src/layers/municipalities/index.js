import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { cableClassificationTypeForScene } from '../submarineCables/surface.js';
import {
  BOUNDARY_KINDS,
  areaAt,
  decodeLine,
  hasLength,
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
const KIND = Object.freeze(
  Object.fromEntries(BOUNDARY_KINDS.map((kind) => [kind.id, kind])),
);
/**
 * The border lines' data sources: what the lines are in the snapshot ("m"
 * municipal only, "c" county and municipal at once) and the kind they are
 * drawn as.
 */
const BORDER_SETS = Object.freeze([
  ['municipality', 'm', 'municipality'],
  ['county', 'c', 'county'],
  ['countyAsMunicipality', 'c', 'municipality'],
]);

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
  scenePick = null,
  pointer = null,
  mapStackEventTarget = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Municipalities require a snapshot source');
  let _viewer = null;
  // One data source per border set, so the chips only show and hide lines
  // that are already there. A county border is a municipal border too: with
  // the counties hidden it is drawn as a municipal one, from a set that is
  // filled the first time it is asked for.
  let _borders = null;
  // The selected municipality's outline, apart from the lines, so selecting
  // one never rebuilds the batched border lines.
  let _highlight = null;
  // The surface the lines are drawn on: the globe's terrain, or the
  // photorealistic 3D tiles when the globe is hidden (the cables' rule).
  let _classificationType;
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
    overlayHost && screenSpaceEventHandlerFactory && scenePick;
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
    const preferred = height < COUNTY_NAMES_ABOVE_M ? 'municipality' : 'county';
    // A hidden kind takes its names with it; the other kind's stand in.
    const kind = _shown.has(preferred)
      ? preferred
      : (BOUNDARY_KINDS.find((entry) => _shown.has(entry.id))?.id ?? null);
    const areas =
      _enabled && _loaded && _view && kind
        ? kind === 'county'
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
        accent: KIND[kind].color,
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

  /** Fill one border set with its lines, drawn as its kind. */
  function addLines(dataSource, code, kind) {
    const material = Cesium.Color.fromCssColorString(kind.color).withAlpha(
      0.85,
    );
    const entities = dataSource.entities;
    entities.suspendEvents();
    try {
      _lines.forEach((points, index) => {
        const line = _snapshot.lines[index];
        if (line.s || line.k !== code || !hasLength(points)) return;
        entities.add({
          polyline: {
            positions: groundPositions(points),
            width: kind.width,
            material,
            clampToGround: true,
            classificationType: _classificationType,
          },
        });
      });
    } finally {
      entities.resumeEvents();
    }
  }

  /** Show the border sets the chips ask for; build nothing twice. */
  function applyShown() {
    if (!_borders) return;
    const municipal = _enabled && _shown.has('municipality');
    const county = _enabled && _shown.has('county');
    const show = {
      municipality: municipal,
      county,
      countyAsMunicipality: municipal && !county,
    };
    for (const [id, code, kind] of BORDER_SETS) {
      const dataSource = _borders[id];
      if (show[id] && _loaded && dataSource.entities.values.length === 0)
        addLines(dataSource, code, KIND[kind]);
      dataSource.show = show[id];
    }
    if (_highlight) _highlight.show = _enabled;
    _viewer?.scene?.requestRender?.();
  }

  /** Move the lines to the surface the map shows now, if it changed. */
  function applyClassification() {
    const next = cableClassificationTypeForScene(_viewer?.scene);
    if (next === _classificationType) return;
    _classificationType = next;
    for (const dataSource of [...Object.values(_borders ?? {}), _highlight]) {
      if (!dataSource) continue;
      const entities = dataSource.entities;
      entities.suspendEvents();
      try {
        for (const entity of entities.values)
          if (entity.polyline) entity.polyline.classificationType = next;
      } finally {
        entities.resumeEvents();
      }
    }
    _viewer?.scene?.requestRender?.();
  }

  function renderSelection() {
    if (!_highlight) return;
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
              classificationType: _classificationType,
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

  /** Whether a pick is one of this layer's own lines. */
  function isOwnLine(picked) {
    const owner = picked?.id?.entityCollection?.owner;
    return Boolean(
      owner &&
      (owner === _highlight || Object.values(_borders ?? {}).includes(owner)),
    );
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_loaded || (pointer && !pointer.isPointerFree())) return;
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(click.position?.x, click.position?.y)) return;
      // Nor is another layer's object: that click is that layer's to select.
      // Only the map itself and these borders count.
      const picked = _viewer.scene.pick(click.position);
      if (!scenePick.isSurfacePick(picked) && !isOwnLine(picked)) return;
      // The surface the lines lie on, not the ellipsoid under it.
      const point = scenePick.pickGroundPosition(_viewer, click.position);
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
      _classificationType = cableClassificationTypeForScene(viewer?.scene);
      const addDataSource = (name) => {
        const dataSource = new Cesium.CustomDataSource(name);
        dataSource.show = false;
        viewer.dataSources.add(dataSource);
        return dataSource;
      };
      _borders = Object.fromEntries(
        BORDER_SETS.map(([id]) => [id, addDataSource(`municipalities-${id}`)]),
      );
      _highlight = addDataSource('municipality-selected');
      if (mapStackEventTarget?.addEventListener) {
        // Switching between the globe and 3D tiles moves the lines' surface.
        // While the layer is off that waits for enable().
        _stackListener = () => {
          if (_enabled) applyClassification();
        };
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          _stackListener,
        );
      }
    },

    enable() {
      _enabled = true;
      applyClassification();
      applyShown();
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
      applyShown();
      _clickHandler?.destroy();
      _clickHandler = null;
      // Nothing of the view outlives the layer being off: no selection, no
      // map centre in the row.
      _centre = null;
      _view = null;
      if (_selected) {
        _selected = null;
        renderSelection();
      }
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_borders) return false;
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
        applyShown();
        renderSelection();
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

    /** Select a municipality by its code and fly over it, while it is on. */
    setParams(params = {}) {
      if (!_enabled || !_loaded) return false;
      const municipality = _snapshot.municipalities.find(
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
      for (const dataSource of Object.values(_borders ?? {}))
        viewer.dataSources.remove(dataSource, true);
      _borders = null;
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
            applyShown();
            publishLabels();
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
