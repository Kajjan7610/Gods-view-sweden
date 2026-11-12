import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { cableClassificationTypeForScene } from '../submarineCables/surface.js';
import {
  AREA_KINDS,
  KIND,
  decodeLine,
  polygonsContain,
  skyddadNaturUrl,
} from './records.js';
import { PROTECTED_NATURE_OVERLAY_SOURCE_ID, buildAreaCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createProtectedNatureSource } from './source.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Above this camera height nothing is read: Sweden is a dot. */
const MAX_SHOW_HEIGHT_M = 3_000_000;
/** The view used when the camera sees the horizon: Sweden. */
const SWEDEN_BOX = Object.freeze([10, 55, 24.5, 69.2]);
const MOVE_SETTLE_MS = 500;
/** The view box is widened by this much, so small pans need no new read. */
const VIEW_PADDING = 0.25;
const FILL_ALPHA = 0.4;
const PICK_PREFIX = 'protected-nature:';
const OUTLINE_COLOR = Cesium.Color.WHITE.withAlpha(0.4);
const SELECTED_COLOR = Cesium.Color.WHITE.withAlpha(0.95);
const KIND_LABELS = Object.freeze({
  np: msg('National park'),
  nr: msg('Nature reserve'),
  kr: msg('Culture reserve'),
});

/**
 * Own one display of Sweden's protected nature: the national parks, nature
 * reserves and culture reserves in the view as areas on the ground, and a
 * card for a clicked area that opens it in Naturvårdsverket's Skyddad natur.
 * A wide view shows the national parks alone; closer in, at most 1 500 areas
 * nearest the view's centre. Share links carry it as token 0d.
 */
export function createProtectedNatureLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  pointer = null,
  mapStackEventTarget = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getAreas !== 'function')
    throw new TypeError('Protected nature requires an areas source');
  let _viewer = null;
  /** The areas and their outlines, and the selected outline apart. */
  let _surface = null;
  let _highlight = null;
  /** A new number for every drawing (see electionDistricts/index.js). */
  let _drawing = 0;
  let _classificationType;
  let _enabled = false;
  let _request = null;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _stackListener = null;
  /** The box the shown areas were read for, padded, and whether it was wide. */
  let _readBox = null;
  let _wide = false;
  let _capped = false;
  let _areas = [];
  let _byId = new Map();
  /** Decoded polygons per area id, for drawing and clicks. */
  let _shapes = new Map();
  let _selected = null;
  let _selectedCardId = null;
  let _lastUpdate = null;
  let _lastError = null;

  const canSelect = () => overlayHost && screenSpaceEventHandlerFactory;

  function draw() {
    if (!_surface) return;
    const entities = _surface.entities;
    _drawing += 1;
    entities.suspendEvents();
    try {
      entities.removeAll();
      if (_enabled)
        for (const area of _areas) {
          const material = Cesium.Color.fromCssColorString(
            KIND[area.t]?.color ?? KIND.nr.color,
          ).withAlpha(FILL_ALPHA);
          (_shapes.get(area.i) ?? []).forEach((rings, index) => {
            const [outer, ...holes] = rings.map((ring) =>
              Cesium.Cartesian3.fromDegreesArray(ring.flat()),
            );
            const id = `${PICK_PREFIX}${area.i}:${index}:${_drawing}`;
            entities.add({
              id,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  outer,
                  holes.map((hole) => new Cesium.PolygonHierarchy(hole)),
                ),
                material,
                classificationType: _classificationType,
              },
            });
            entities.add({
              id: `${id}:edge`,
              polyline: {
                positions: [...outer, outer[0]],
                width: 1.2,
                material: OUTLINE_COLOR,
                clampToGround: true,
                classificationType: _classificationType,
              },
            });
          });
        }
    } finally {
      entities.resumeEvents();
    }
    _surface.show = _enabled;
    _viewer?.scene?.requestRender?.();
  }

  function drawSelection() {
    if (_highlight) {
      const entities = _highlight.entities;
      entities.suspendEvents();
      try {
        entities.removeAll();
        if (_enabled && _selected)
          for (const rings of _shapes.get(_selected.i) ?? []) {
            const outer = Cesium.Cartesian3.fromDegreesArray(rings[0].flat());
            entities.add({
              polyline: {
                positions: [...outer, outer[0]],
                width: 3.5,
                material: SELECTED_COLOR,
                clampToGround: true,
                classificationType: _classificationType,
              },
            });
          }
      } finally {
        entities.resumeEvents();
      }
      _highlight.show = _enabled;
    }
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function publishSelectedCard() {
    if (!overlayHost) return;
    if (!_selected || !_enabled) {
      _selectedCardId = null;
      overlayHost.setEntries(
        PROTECTED_NATURE_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const area = _selected;
    const card = buildAreaCard(area, { linkable: Boolean(openExternal) });
    const [west, south, east, north] = area.b;
    card.position = Cesium.Cartesian3.fromDegrees(
      (west + east) / 2,
      (south + north) / 2,
      0,
    );
    if (openExternal)
      card.activate = () => {
        openExternal(skyddadNaturUrl(area.i));
        return true;
      };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      PROTECTED_NATURE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function select(area) {
    if (area === _selected) return;
    _selected = area;
    drawSelection();
    _rowListener?.();
  }

  /** The view as a padded box, or null when it is too high or unknown. */
  function readBox() {
    const camera = _viewer?.camera;
    const height = camera?.positionCartographic?.height;
    if (!Number.isFinite(height) || height > MAX_SHOW_HEIGHT_M) return null;
    const rect = camera.computeViewRectangle?.(Cesium.Ellipsoid.WGS84);
    if (!rect) return [...SWEDEN_BOX];
    const deg = Cesium.Math.toDegrees;
    const [west, south, east, north] = [
      deg(rect.west),
      deg(rect.south),
      deg(rect.east),
      deg(rect.north),
    ];
    const padX = (east - west) * VIEW_PADDING;
    const padY = (north - south) * VIEW_PADDING;
    return [west - padX, south - padY, east + padX, north + padY];
  }

  const within = (inner, outer) =>
    Boolean(outer) &&
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3];

  /** Read the areas for the view, unless the shown ones cover it. */
  async function refresh() {
    if (!_enabled || !_viewer) return false;
    const box = readBox();
    if (!box) {
      if (_areas.length) {
        _areas = [];
        _readBox = null;
        draw();
        _rowListener?.();
      }
      return true;
    }
    const [w, s, e, n] = box;
    const inset = VIEW_PADDING / (1 + 2 * VIEW_PADDING);
    const unpadded = [
      w + (e - w) * inset,
      s + (n - s) * inset,
      e - (e - w) * inset,
      n - (n - s) * inset,
    ];
    // Inside a box already read in full, nothing new can show.
    if (!_capped && !_wide && within(unpadded, _readBox)) return true;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    try {
      const answer = await source.getAreas({
        bbox: box,
        signal: request.signal,
      });
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      _areas = answer.areas;
      _byId = new Map(_areas.map((area) => [area.i, area]));
      _shapes = new Map(
        _areas.map((area) => [
          area.i,
          (area.g ?? []).map((rings) => rings.map((ring) => decodeLine(ring))),
        ]),
      );
      _wide = answer.wide;
      _capped = answer.capped;
      _readBox = box;
      _lastUpdate = answer.built ? Date.parse(answer.built) : null;
      _lastError = null;
      if (_selected && !_byId.has(_selected.i)) _selected = null;
      draw();
      drawSelection();
      _rowListener?.();
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      console.warn('[Data:ProtectedNature] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Protected nature unavailable');
      _rowListener?.();
      return true;
    } finally {
      if (_request === request) _request = null;
    }
  }

  function followCamera() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
  }

  function applyClassification() {
    const next = cableClassificationTypeForScene(_viewer?.scene);
    if (next === _classificationType) return;
    _classificationType = next;
    draw();
    drawSelection();
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
      );
      // A click on this layer's own card opens the area in Skyddad natur.
      if (
        cardHit?.sourceId === PROTECTED_NATURE_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId &&
        _selected &&
        openExternal
      )
        openExternal(skyddadNaturUrl(_selected.i));
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = _viewer.scene.pick(click.position);
      const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      if (id?.startsWith(PICK_PREFIX)) {
        const area = _byId.get(id.slice(PICK_PREFIX.length).split(':')[0]);
        select(area && area !== _selected ? area : null);
        return;
      }
      // Anything else picked is another layer's to select.
      if (picked) return;
      if (_selected) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'protected-nature',
    name: 'Protected Nature (Sweden)',
    icon: '🌲',
    source: 'Naturvårdsverket',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Protected nature layer is already initialized');
      _viewer = viewer;
      _classificationType = cableClassificationTypeForScene(viewer?.scene);
      _surface = new Cesium.CustomDataSource('protected-nature');
      _highlight = new Cesium.CustomDataSource('protected-nature-selected');
      for (const dataSource of [_surface, _highlight]) {
        dataSource.show = false;
        viewer.dataSources.add(dataSource);
      }
      if (mapStackEventTarget?.addEventListener) {
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
      overlayHost?.setVisible?.(PROTECTED_NATURE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      if (!_removeMove && _viewer?.camera) {
        const removers = [
          _viewer.camera.moveEnd?.addEventListener?.(followCamera),
          _viewer.camera.changed?.addEventListener?.(followCamera),
        ].filter(Boolean);
        _removeMove = () => removers.forEach((remove) => remove());
      }
    },

    disable() {
      _request?.abort();
      _request = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      _clickHandler?.destroy();
      _clickHandler = null;
      _selected = null;
      _areas = [];
      _byId = new Map();
      _shapes = new Map();
      _readBox = null;
      _wide = false;
      _capped = false;
      draw();
      drawSelection();
      overlayHost?.clearSource?.(PROTECTED_NATURE_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(PROTECTED_NATURE_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      return refresh();
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_stackListener)
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          _stackListener,
        );
      _stackListener = null;
      for (const dataSource of [_surface, _highlight])
        if (dataSource) viewer?.dataSources?.remove(dataSource, true);
      _surface = null;
      _highlight = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const legend = AREA_KINDS.map((kind) => ({
        label: t(KIND_LABELS[kind.id]),
        color: kind.color,
        count: _areas.filter((area) => area.t === kind.id).length,
      })).filter((item) => item.count > 0);
      const blurb = t(
        'Naturvårdsverket’s national parks, nature reserves and culture reserves. Click an area for its size and age, and to open it in Skyddad natur.',
      );
      return {
        legend: legend.map((item, index) =>
          index === 0 ? { ...item, blurb } : item,
        ),
        info: _wide
          ? t('Zoom in to see the nature reserves and culture reserves.')
          : _capped
            ? t('The {count} areas nearest the centre are shown.', {
                count: _areas.length,
              })
            : '',
      };
    },

    /** Select an area by its Naturvårdsregistret id, while it is shown. */
    setParams(params = {}) {
      const area = _byId.get(String(params.nvrid ?? ''));
      if (!_enabled || !area) return false;
      select(area);
      return true;
    },

    /** The shown area containing a point, or null (tools and tests). */
    areaAt(point) {
      for (const area of _areas) {
        const [w, s, e, n] = area.b;
        if (point[0] < w || point[0] > e || point[1] < s || point[1] > n)
          continue;
        if (polygonsContain(_shapes.get(area.i) ?? [], point)) return area;
      }
      return null;
    },

    getStats() {
      return {
        count: _areas.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
