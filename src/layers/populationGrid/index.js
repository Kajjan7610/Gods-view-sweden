import { msg, onLocaleChange, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { cableClassificationTypeForScene } from '../submarineCables/surface.js';
import { analystRows } from '../analystRows.js';
import {
  DENSITY_CLASSES,
  GRID_YEAR,
  levelForBox,
  readSquareRow,
  shownDensity,
  squareCentre,
  squareCorners,
} from './records.js';
import {
  POPULATION_GRID_OVERLAY_SOURCE_ID,
  buildSquareCard,
  classLabel,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createPopulationGridSource } from './source.js';

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
/**
 * Each class's fill opacity, light to dark: the sparse classes stay faint, so
 * the land outside the towns is not blanketed.
 */
const FILL_ALPHAS = Object.freeze([0.12, 0.16, 0.2, 0.25, 0.31, 0.37, 0.42]);
export const POPULATION_GRID_LAYER_ID = 'population-grid';
const PICK_PREFIX = 'population-grid:';
/** The selected outline's ids: not a square's, so a click on it is not one. */
const SELECTED_PICK_PREFIX = 'population-grid-selected:';
const SELECTED_COLOR = Object.freeze([1, 1, 1, 0.95]);
const SELECTED_WIDTH = 3;
/** Each class's fill, worked out once. */
const CLASS_FILLS = Object.freeze(
  DENSITY_CLASSES.map(({ color }, index) => {
    const [r, g, b] = cssColor(color);
    return Object.freeze([r, g, b, FILL_ALPHAS[index]]);
  }),
);
const SQUARE_NAME = msg('{size} km square');

/**
 * Own one display of Sweden's population: SCB's people per square as flat
 * coloured squares on the ground, light to dark by people per km². Close up
 * the 1 km squares, wider the 5, 10 and 25 km sums; at most 3 000 squares
 * nearest the view's centre. The squares are flat fills in two sets, each
 * drawn as a few ground batches (no outlines, no heights, no labels), so a
 * whole view costs a handful of draw calls.
 *
 * Privacy: a 1 km square comes as its colour class alone (fewer than 5
 * people reads "1–4"); it has no card, is never picked and is not in the
 * analyst's records. A summed square's card shows its people rounded.
 * Share links carry the layer as token 15 and nothing of a square.
 */
export function createPopulationGridLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  mapStackEventTarget = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSquares !== 'function')
    throw new TypeError('Population grid requires a squares source');
  let _viewer = null;
  /** The 1 km squares (never picked), the summed ones, the selected edge. */
  let _fine = null;
  let _summed = null;
  let _highlight = null;
  /** The surface the squares lie on (the cables' rule). */
  let _clampTo;
  let _enabled = false;
  let _request = null;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _stackListener = null;
  /** The box the shown squares were read for, padded, and its level. */
  let _readBox = null;
  let _level = null;
  let _capped = false;
  let _squares = [];
  let _byId = new Map();
  /** Corners per square id, [lon, lat] each, for drawing and the outline. */
  let _corners = new Map();
  let _selected = null;
  let _offLocale = null;
  let _selectedCardId = null;
  let _lastUpdate = null;
  let _lastError = null;

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(POPULATION_GRID_LAYER_ID);
  const drawSets = () => [_fine, _summed, _highlight].filter(Boolean);

  /** Every square one flat fill, in the set its size belongs to. */
  function draw() {
    if (!_fine) return;
    const items = [];
    if (_enabled)
      for (const square of _squares)
        items.push({
          id: `${PICK_PREFIX}${square.id}`,
          geometry: {
            kind: 'polygon',
            rings: [
              _corners.get(square.id).map(([lon, lat]) => ({ lon, lat })),
            ],
          },
          fill: CLASS_FILLS[square.cls],
          height: 'clampGround',
          lit: false,
        });
    const summed = _level !== null && _level > 1;
    _fine.set(summed ? [] : items);
    _summed.set(summed ? items : []);
    _fine.show = _summed.show = _enabled;
    requestRender();
  }

  function drawSelection() {
    if (_highlight) {
      const corners = _selected ? _corners.get(_selected.id) : null;
      _highlight.set(
        _enabled && corners
          ? [
              {
                id: `${SELECTED_PICK_PREFIX}${_selected.id}`,
                positions: [...corners, corners[0]].map(([lon, lat]) =>
                  fromDegrees(lon, lat),
                ),
                widthPx: SELECTED_WIDTH,
                mode: 'draped',
                style: { kind: 'solid', color: SELECTED_COLOR },
              },
            ]
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
        POPULATION_GRID_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const square = _selected;
    const card = buildSquareCard(square);
    const [lon, lat] = squareCentre(square.east, square.north, square.km);
    card.position = fromDegrees(lon, lat, 0);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      POPULATION_GRID_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function select(square) {
    // Only a summed square has a card.
    const next = square?.summed ? square : null;
    if (next === _selected) return;
    _selected = next;
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

  /** Read the squares for the view, unless the shown ones cover it. */
  async function refresh() {
    if (!_enabled || !_viewer) return false;
    const box = readBox();
    if (!box) {
      if (_squares.length) {
        _squares = [];
        _readBox = null;
        _selected = null;
        draw();
        drawSelection();
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
    // Inside a box already read in full, at the same square size, nothing
    // new can show.
    if (!_capped && levelForBox(box) === _level && within(unpadded, _readBox))
      return true;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    try {
      const answer = await source.getSquares({
        bbox: box,
        signal: request.signal,
      });
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      const km = answer.level;
      _squares = answer.squares
        .map((row) => readSquareRow(row, km))
        .filter(Boolean);
      _byId = new Map(_squares.map((square) => [square.id, square]));
      _corners = new Map(
        _squares.map((square) => [
          square.id,
          squareCorners(square.east, square.north, km),
        ]),
      );
      _level = km;
      _capped = answer.capped;
      _readBox = box;
      _lastUpdate = answer.built ? Date.parse(answer.built) : null;
      _lastError = null;
      if (_selected) _selected = _byId.get(_selected.id) ?? null;
      draw();
      drawSelection();
      _rowListener?.();
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      console.warn('[Data:PopulationGrid] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Population grid unavailable');
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
    picking.registerPickOwner?.(POPULATION_GRID_LAYER_ID, isOwnPick);
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
      if (isOwnPick(pickId)) {
        const square = _byId.get(pickId.slice(PICK_PREFIX.length));
        select(square && square !== _selected ? square : null);
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
    picking?.unregisterPickOwner?.(POPULATION_GRID_LAYER_ID);
  }

  const layer = {
    id: POPULATION_GRID_LAYER_ID,
    name: 'Population per km² (Sweden)',
    icon: '👥',
    source: 'SCB',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Population grid layer is already initialized');
      _clampTo = cableClassificationTypeForScene(viewer);
      const draw = drawOf(viewer);
      const spec = (name, extra = {}) => ({
        id: `${POPULATION_GRID_LAYER_ID}:${name}`,
        clampTo: _clampTo,
        show: false,
        ...extra,
      });
      // The 1 km squares never take part in picks: they have no card, and
      // the ground under them stays clickable.
      _fine = draw.shapes(spec('squares', { pickable: false }));
      _summed = draw.shapes(spec('sums'));
      _highlight = draw.lines(spec('selected', { pickable: false }));
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
      // An open card and the legend follow the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selected) publishSelectedCard();
        _rowListener?.();
      });
    },

    enable() {
      _enabled = true;
      applyClassification();
      overlayHost?.setVisible?.(POPULATION_GRID_OVERLAY_SOURCE_ID, true);
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
      _squares = [];
      _byId = new Map();
      _corners = new Map();
      _readBox = null;
      _level = null;
      _capped = false;
      draw();
      drawSelection();
      overlayHost?.clearSource?.(POPULATION_GRID_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(POPULATION_GRID_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      return refresh();
    },

    destroy() {
      _offLocale?.();
      _offLocale = null;
      layer.disable();
      if (_stackListener)
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          _stackListener,
        );
      _stackListener = null;
      for (const set of drawSets()) set.dispose();
      _fine = null;
      _summed = null;
      _highlight = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const summed = _level !== null && _level > 1;
      // "Under 1 per km²" can only be a summed square.
      const legend = DENSITY_CLASSES.map((cls, index) => ({
        label: classLabel(index),
        color: cls.color,
      })).filter((_, index) => summed || index > 0);
      const blurb = t(
        'SCB’s people per square kilometre, end of {year}. Close up the 1 km squares, farther out the 5, 10 and 25 km squares summed from them. Fewer than 5 people show as 1–4.',
        { year: GRID_YEAR },
      );
      const info =
        _level === null
          ? ''
          : [
              summed
                ? t(
                    '{size} km squares (processed from SCB data); click one for its people. Zoom in for 1 km squares.',
                    { size: _level },
                  )
                : t('1 km squares (Source: SCB).'),
              _capped
                ? t('The {count} squares nearest the centre are shown.', {
                    count: _squares.length,
                  })
                : '',
            ]
              .filter(Boolean)
              .join(' ');
      return {
        legend: legend.map((item, index) =>
          index === 0 ? { ...item, blurb } : item,
        ),
        info,
      };
    },

    /**
     * What a picked summed square is called, at its middle as in the
     * records. A 1 km square is not named: it has no card.
     */
    findByQuery(pickId) {
      if (!isOwnPick(pickId)) return null;
      const square = _byId.get(pickId.slice(PICK_PREFIX.length));
      if (!square || !(square.km > 1)) return null;
      const [longitude, latitude] = squareCentre(
        square.east,
        square.north,
        square.km,
      );
      return {
        name: t(SQUARE_NAME, { size: square.km }),
        latitude,
        longitude,
      };
    },

    /**
     * The summed squares shown, each at its middle, with its rounded people
     * and people per km². The 1 km squares are never handed out.
     */
    getAnalystRecords(maxCount = 1500) {
      if (!_enabled || !(_level > 1)) return [];
      return analystRows(_squares, maxCount, {
        place: (square) => squareCentre(square.east, square.north, square.km),
        name: (square) => t(SQUARE_NAME, { size: square.km }),
        extra: (square) => ({
          id: `population-${square.km}km-${square.east / 1000}-${square.north / 1000}`,
          squareKm: square.km,
          people: square.people,
          fewerThan5: square.people === null,
          peoplePerKm2: shownDensity(square),
          densityClass: classLabel(square.cls),
          source: t('Processed from SCB data'),
        }),
      });
    },

    getStats() {
      return {
        count: _squares.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
