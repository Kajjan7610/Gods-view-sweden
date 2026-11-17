import { msg, t } from '../../i18n/index.js';
import {
  fromDegrees,
  fromDegreesInto,
  toLonLatH,
} from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
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
 * The border lines' sets: what the lines are in the snapshot ("m"
 * municipal only, "c" county and municipal at once) and the kind they are
 * drawn as.
 */
const BORDER_SETS = Object.freeze([
  ['municipality', 'm', 'municipality'],
  ['county', 'c', 'county'],
  ['countyAsMunicipality', 'c', 'municipality'],
]);

export const MUNICIPALITIES_LAYER_ID = 'municipalities';
/** The border sets' ids start with this; picks name them as `Hit.set`. */
export const MUNICIPALITY_SET_PREFIX = 'municipalities:';
const BORDER_PICK_PREFIX = 'municipality-border:';
const SELECTED_PICK_PREFIX = 'municipality-selected:';
const BORDER_ALPHA = 0.85;
const SELECTED_COLOR = Object.freeze([1, 1, 1, 0.9]);
const SELECTED_WIDTH = 4;

const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];

/** [lon, lat] pairs on the ellipsoid, as packed ECEF `x, y, z`. */
function groundPositions(points) {
  const out = new Float64Array(points.length * 3);
  const at = { x: 0, y: 0, z: 0 };
  points.forEach(([lon, lat], index) => {
    fromDegreesInto(lon, lat, 0, at);
    out[index * 3] = at.x;
    out[index * 3 + 1] = at.y;
    out[index * 3 + 2] = at.z;
  });
  return out;
}

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
  pointer = null,
  mapStackEventTarget = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Municipalities require a snapshot source');
  let _viewer = null;
  // One line set per border set, so the chips only show and hide lines
  // that are already there. A county border is a municipal border too: with
  // the counties hidden it is drawn as a municipal one, from a set that is
  // filled the first time it is asked for.
  let _borders = null;
  // The selected municipality's outline, apart from the lines, so selecting
  // one never rebuilds the batched border lines.
  let _highlight = null;
  /** The ids of the sets above, as picks name them. */
  let _setIds = new Set();
  // The surface the lines are drawn on: the globe's terrain, or the
  // photorealistic 3D tiles when the globe is hidden (the cables' rule).
  let _clampTo;
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

  const canSelect = () => Boolean(overlayHost);
  const labelPosition = (area) => fromDegrees(area.label[0], area.label[1], 0);
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(MUNICIPALITIES_LAYER_ID);
  const lineSets = () => [...Object.values(_borders ?? {}), _highlight];

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
    const height = _viewer ? findCamera(_viewer)?.pose()?.height : undefined;
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

  /** Fill one border set with its lines, drawn as its kind, in one write. */
  function addLines(set, code, kind) {
    const style = {
      kind: 'solid',
      color: withAlpha(cssColor(kind.color), BORDER_ALPHA),
    };
    const items = [];
    _lines.forEach((points, index) => {
      const line = _snapshot.lines[index];
      if (line.s || line.k !== code || !hasLength(points)) return;
      items.push({
        id: `${BORDER_PICK_PREFIX}${index}`,
        positions: groundPositions(points),
        widthPx: kind.width,
        mode: 'draped',
        style,
      });
    });
    set.set(items);
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
      const set = _borders[id];
      if (show[id] && _loaded && set.size() === 0)
        addLines(set, code, KIND[kind]);
      set.show = show[id];
    }
    if (_highlight) _highlight.show = _enabled;
    requestRender();
  }

  /** Move the lines to the surface the map shows now, if it changed. */
  function applyClassification() {
    const next = cableClassificationTypeForScene(_viewer);
    if (next === _clampTo) return;
    _clampTo = next;
    for (const set of lineSets()) set?.setOptions({ clampTo: next });
    requestRender();
  }

  function renderSelection() {
    if (!_highlight) return;
    _highlight.set(
      _selected
        ? _selected.rings.map((ring, index) => ({
            id: `${SELECTED_PICK_PREFIX}${_selected.code}:${index}`,
            positions: groundPositions(ringPoints(ring, _lines)),
            widthPx: SELECTED_WIDTH,
            mode: 'draped',
            style: { kind: 'solid', color: SELECTED_COLOR },
          }))
        : [],
    );
    publishSelectedCard();
    publishLabels();
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
    // A viewer with no renderer input bound takes no clicks.
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (!_loaded || (pointer && !pointer.isPointerFree())) return;
      const at = click.screenPosition;
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(at?.x, at?.y)) return;
      // Nor is another layer's object: that click is that layer's to select.
      // Only the map itself (no hit) and these borders count.
      const picked = click.topHit;
      if (picked && !_setIds.has(picked.set)) return;
      // The surface the lines lie on, not the ellipsoid under it.
      const point = click.ground?.() ?? null;
      const where = point ? toLonLatH(point) : null;
      if (!where) return;
      const hit = areaAt(_municipalityIndex, [where.lon, where.lat]);
      select(hit && hit !== _selected ? hit : null);
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
  }

  const layer = {
    id: MUNICIPALITIES_LAYER_ID,
    name: 'Municipalities & Counties (Sweden)',
    icon: '🗺️',
    source: 'SCB',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Municipalities layer is already initialized');
      _clampTo = cableClassificationTypeForScene(viewer);
      const draw = drawOf(viewer);
      const addSet = (name) =>
        draw.lines({
          id: `${MUNICIPALITY_SET_PREFIX}${name}`,
          clampTo: _clampTo,
          show: false,
        });
      _borders = Object.fromEntries(
        BORDER_SETS.map(([id]) => [id, addSet(id)]),
      );
      _highlight = addSet('selected');
      _setIds = new Set(lineSets().map((set) => set.id));
      _viewer = viewer;
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
      removeClickHandler();
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
        findCamera(_viewer)?.flyTo(
          { lon, lat, height: 60_000 },
          { durationS: 1.8 },
        );
      }
      return true;
    },

    destroy() {
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
      for (const set of lineSets()) set?.dispose();
      _borders = null;
      _highlight = null;
      _setIds = new Set();
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
