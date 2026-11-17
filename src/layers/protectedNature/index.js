import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
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
export const PROTECTED_NATURE_LAYER_ID = 'protected-nature';
const PICK_PREFIX = 'protected-nature:';
/** The selected outline's ids: not an area's, so a click on it is not one. */
const SELECTED_PICK_PREFIX = 'protected-nature-selected:';
const OUTLINE_COLOR = Object.freeze([1, 1, 1, 0.4]);
const OUTLINE_WIDTH = 1.2;
const SELECTED_COLOR = Object.freeze([1, 1, 1, 0.95]);
const SELECTED_WIDTH = 3.5;
const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];
/** A ring of [lon, lat] pairs as the draw port's positions. */
const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));
/** A ring's edge on the ellipsoid, closed back to its first point, in ECEF. */
const closedRing = (ring) =>
  [...ring, ring[0]].map(([lon, lat]) => fromDegrees(lon, lat));
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
  picking = null,
  pointer = null,
  mapStackEventTarget = null,
  openExternal = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getAreas !== 'function')
    throw new TypeError('Protected nature requires an areas source');
  let _viewer = null;
  /** The areas, their outlines, and the selected outline apart. */
  let _surface = null;
  let _edges = null;
  let _highlight = null;
  /** The surface the areas lie on (the cables' rule). */
  let _clampTo;
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

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(PROTECTED_NATURE_LAYER_ID);
  const drawSets = () => [_surface, _edges, _highlight].filter(Boolean);

  /** Each polygon an area in one set, its outer edge a line in another. */
  function draw() {
    if (!_surface) return;
    const areas = [];
    const outlines = [];
    if (_enabled)
      for (const area of _areas) {
        const fill = withAlpha(
          cssColor(KIND[area.t]?.color ?? KIND.nr.color),
          FILL_ALPHA,
        );
        (_shapes.get(area.i) ?? []).forEach((rings, index) => {
          const id = `${PICK_PREFIX}${area.i}:${index}`;
          areas.push({
            id,
            geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
            fill,
            height: 'clampGround',
          });
          outlines.push({
            id: `${id}:edge`,
            positions: closedRing(rings[0]),
            widthPx: OUTLINE_WIDTH,
            mode: 'draped',
            style: { kind: 'solid', color: OUTLINE_COLOR },
          });
        });
      }
    _surface.set(areas);
    _edges.set(outlines);
    _surface.show = _edges.show = _enabled;
    requestRender();
  }

  function drawSelection() {
    if (_highlight) {
      _highlight.set(
        _enabled && _selected
          ? (_shapes.get(_selected.i) ?? []).map((rings, index) => ({
              id: `${SELECTED_PICK_PREFIX}${_selected.i}:${index}`,
              positions: closedRing(rings[0]),
              widthPx: SELECTED_WIDTH,
              mode: 'draped',
              style: { kind: 'solid', color: SELECTED_COLOR },
            }))
          : [],
      );
      _highlight.show = _enabled;
    }
    publishSelectedCard();
    requestRender();
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
    card.position = fromDegrees((west + east) / 2, (south + north) / 2, 0);
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
    const camera = _viewer ? findCamera(_viewer) : null;
    const height = camera?.pose()?.height;
    if (!Number.isFinite(height) || height > MAX_SHOW_HEIGHT_M) return null;
    const rect = camera.viewRectangle?.() ?? null;
    if (!rect) return [...SWEDEN_BOX];
    const { west, south, east, north } = rect;
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
    const next = cableClassificationTypeForScene(_viewer);
    if (next === _clampTo) return;
    _clampTo = next;
    for (const set of drawSets()) set.setOptions({ clampTo: next });
    requestRender();
  }

  const isOwnPick = (pickId) =>
    typeof pickId === 'string' && pickId.startsWith(PICK_PREFIX);

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(PROTECTED_NATURE_LAYER_ID, isOwnPick);
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
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y);
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
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      if (isOwnPick(pickId)) {
        const area = _byId.get(pickId.slice(PICK_PREFIX.length).split(':')[0]);
        select(area && area !== _selected ? area : null);
        return;
      }
      // Anything else picked is another layer's to select.
      if (picked) return;
      if (_selected) select(null);
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(PROTECTED_NATURE_LAYER_ID);
  }

  const layer = {
    id: PROTECTED_NATURE_LAYER_ID,
    name: 'Protected Nature (Sweden)',
    icon: '🌲',
    source: 'Naturvårdsverket',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Protected nature layer is already initialized');
      _clampTo = cableClassificationTypeForScene(viewer);
      const draw = drawOf(viewer);
      const spec = (name) => ({
        id: `${PROTECTED_NATURE_LAYER_ID}:${name}`,
        clampTo: _clampTo,
        show: false,
      });
      _surface = draw.shapes(spec('areas'));
      _edges = draw.lines(spec('edges'));
      _highlight = draw.lines(spec('selected'));
      _viewer = viewer;
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
      const camera = _viewer ? findCamera(_viewer) : null;
      if (!_removeMove && camera) {
        const removers = [
          camera.on('moveEnd', followCamera),
          camera.on('changed', followCamera),
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
      removeClickHandler();
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

    destroy() {
      layer.disable();
      if (_stackListener)
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          _stackListener,
        );
      _stackListener = null;
      for (const set of drawSets()) set.dispose();
      _surface = null;
      _edges = null;
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
