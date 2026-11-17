import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { cableClassificationTypeForScene } from '../submarineCables/surface.js';
import {
  OTHER_PARTIES,
  PARTIES,
  TURNOUT_CLASSES,
  decodeLine,
  leadingParty,
  polygonsContain,
  turnoutClass,
} from './records.js';
import {
  ELECTION_DISTRICTS_OVERLAY_SOURCE_ID,
  buildDistrictCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createElectionDistrictsSource } from './source.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Above this camera height the districts are too small to show. */
export const MAX_SHOW_HEIGHT_M = 120_000;
const MOVE_SETTLE_MS = 500;
/** The view box is widened by this much, so small pans need no new read. */
const VIEW_PADDING = 0.25;
const FILL_ALPHA = 0.45;
const NO_RESULT_COLOR = '#616161';
export const ELECTION_DISTRICTS_LAYER_ID = 'election-districts';
const PICK_PREFIX = 'election-district:';
/** The selected outline's ids: not a district's, so a click on it is not one. */
const SELECTED_PICK_PREFIX = 'election-district-selected:';
const OUTLINE_COLOR = Object.freeze([1, 1, 1, 0.35]);
const OUTLINE_WIDTH = 1.2;
const SELECTED_COLOR = Object.freeze([1, 1, 1, 0.95]);
const SELECTED_WIDTH = 3.5;
const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];
/** A ring of [lon, lat] pairs as the draw port's positions. */
const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));
/** A ring's edge on the ellipsoid, closed back to its first point, in ECEF. */
const closedRing = (ring) =>
  [...ring, ring[0]].map(([lon, lat]) => fromDegrees(lon, lat));
const TURNOUT_LABELS = Object.freeze({
  'below-70': msg('Below 70 %'),
  '70-80': msg('70 to 80 %'),
  '80-85': msg('80 to 85 %'),
  '85-90': msg('85 to 90 %'),
  'above-90': msg('90 % and above'),
});

/**
 * Own one display of the 2026 Riksdag election per election district: the
 * districts in the view as areas on the ground, coloured by their largest
 * party or by turnout, and a card with every party's share for a clicked
 * district. Shown below 120 km, at most 1 200 districts nearest the view's
 * centre. Share links carry it as token 0e.
 */
export function createElectionDistrictsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  mapStackEventTarget = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getDistricts !== 'function')
    throw new TypeError('Election districts require a districts source');
  let _viewer = null;
  /** The district areas, their outlines, and the selected outline apart. */
  let _areas = null;
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
  /** 'party' or 'turnout'. */
  let _mode = 'party';
  /** The box the shown districts were read for, padded. */
  let _readBox = null;
  let _districts = [];
  let _byCode = new Map();
  /** Decoded polygons per district code, for drawing and clicks. */
  let _shapes = new Map();
  let _capped = false;
  let _tooHigh = false;
  let _selected = null;
  let _lastUpdate = null;
  let _lastError = null;

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(ELECTION_DISTRICTS_LAYER_ID);
  const drawSets = () => [_areas, _edges, _highlight].filter(Boolean);

  function colorOf(district) {
    const css =
      _mode === 'turnout'
        ? (turnoutClass(district.t)?.color ?? NO_RESULT_COLOR)
        : (leadingParty(district.s)?.color ?? NO_RESULT_COLOR);
    return cssColor(css);
  }

  /**
   * Draw the shown districts, each polygon an area in one set and its outer
   * edge a line in another; `edges: false` recolours the areas alone.
   */
  function draw({ edges = true } = {}) {
    if (!_areas) return;
    const areas = [];
    const outlines = [];
    if (_enabled)
      for (const district of _districts) {
        const fill = withAlpha(colorOf(district), FILL_ALPHA);
        (_shapes.get(district.c) ?? []).forEach((rings, index) => {
          const id = `${PICK_PREFIX}${district.c}:${index}`;
          areas.push({
            id,
            geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
            fill,
            height: 'clampGround',
          });
          if (edges)
            outlines.push({
              id: `${id}:edge`,
              positions: closedRing(rings[0]),
              widthPx: OUTLINE_WIDTH,
              mode: 'draped',
              style: { kind: 'solid', color: OUTLINE_COLOR },
            });
        });
      }
    _areas.set(areas);
    _areas.show = _enabled;
    if (edges) {
      _edges.set(outlines);
      _edges.show = _enabled;
    }
    requestRender();
  }

  /** The selected district's outline, apart from the batches. */
  function drawSelection() {
    if (_highlight) {
      _highlight.set(
        _enabled && _selected
          ? (_shapes.get(_selected.c) ?? []).map((rings, index) => ({
              id: `${SELECTED_PICK_PREFIX}${_selected.c}:${index}`,
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
      overlayHost.setEntries(
        ELECTION_DISTRICTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildDistrictCard(_selected);
    const [west, south, east, north] = _selected.b;
    card.position = fromDegrees((west + east) / 2, (south + north) / 2, 0);
    overlayHost.setEntries(
      ELECTION_DISTRICTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function select(district) {
    if (district === _selected) return;
    _selected = district;
    drawSelection();
    _rowListener?.();
  }

  /** The view as a padded box, or null when it is too high or unknown. */
  function readBox() {
    const camera = _viewer ? findCamera(_viewer) : null;
    const height = camera?.pose()?.height;
    if (!Number.isFinite(height)) return null;
    _tooHigh = height > MAX_SHOW_HEIGHT_M;
    if (_tooHigh) return null;
    const rect = camera.viewRectangle?.() ?? null;
    if (!rect) return null;
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

  /** Read the districts for the view, unless the shown ones cover it. */
  async function refresh() {
    if (!_enabled || !_viewer) return false;
    const box = readBox();
    if (!box) {
      if (_districts.length || _tooHigh) {
        _districts = [];
        _readBox = null;
        draw();
        _rowListener?.();
      }
      return true;
    }
    // Inside the box already read, nothing new can show, unless it was cut.
    const [w, s, e, n] = box;
    const unpadded = [
      w + (e - w) * (VIEW_PADDING / (1 + 2 * VIEW_PADDING)),
      s + (n - s) * (VIEW_PADDING / (1 + 2 * VIEW_PADDING)),
      e - (e - w) * (VIEW_PADDING / (1 + 2 * VIEW_PADDING)),
      n - (n - s) * (VIEW_PADDING / (1 + 2 * VIEW_PADDING)),
    ];
    if (!_capped && within(unpadded, _readBox)) return true;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    try {
      const answer = await source.getDistricts({
        bbox: box,
        signal: request.signal,
      });
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      _districts = answer.districts;
      _byCode = new Map(_districts.map((district) => [district.c, district]));
      _shapes = new Map(
        _districts.map((district) => [
          district.c,
          (district.g ?? []).map((rings) =>
            rings.map((ring) => decodeLine(ring)),
          ),
        ]),
      );
      _capped = answer.capped;
      _readBox = box;
      _lastUpdate = answer.built ? Date.parse(answer.built) : null;
      _lastError = null;
      if (_selected && !_byCode.has(_selected.c)) _selected = null;
      draw();
      drawSelection();
      _rowListener?.();
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled)
        return false;
      console.warn('[Data:ElectionDistricts] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Election data unavailable');
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

  /** Move the areas to the surface the map shows now, if it changed. */
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
    picking.registerPickOwner?.(ELECTION_DISTRICTS_LAYER_ID, isOwnPick);
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
        const district = _byCode.get(
          pickId.slice(PICK_PREFIX.length).split(':')[0],
        );
        select(district && district !== _selected ? district : null);
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
    picking?.unregisterPickOwner?.(ELECTION_DISTRICTS_LAYER_ID);
  }

  function setMode(mode) {
    if (_mode === mode) return;
    _mode = mode;
    // Only the areas' colours change; the outlines stay as drawn.
    draw({ edges: false });
    _rowListener?.();
  }

  const layer = {
    id: ELECTION_DISTRICTS_LAYER_ID,
    name: 'Election Districts 2026 (Sweden)',
    icon: '🗳️',
    source: 'Valmyndigheten',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Election districts layer is already initialized');
      _clampTo = cableClassificationTypeForScene(viewer);
      const draw = drawOf(viewer);
      const spec = (name) => ({
        id: `${ELECTION_DISTRICTS_LAYER_ID}:${name}`,
        clampTo: _clampTo,
        show: false,
      });
      _areas = draw.shapes(spec('areas'));
      _edges = draw.lines(spec('edges'));
      _highlight = draw.lines(spec('selected'));
      _viewer = viewer;
      if (mapStackEventTarget?.addEventListener) {
        // Switching between the globe and 3D tiles moves the areas' surface.
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
      overlayHost?.setVisible?.(ELECTION_DISTRICTS_OVERLAY_SOURCE_ID, true);
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
      _districts = [];
      _byCode = new Map();
      _shapes = new Map();
      _readBox = null;
      _capped = false;
      draw();
      drawSelection();
      overlayHost?.clearSource?.(ELECTION_DISTRICTS_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(ELECTION_DISTRICTS_OVERLAY_SOURCE_ID, false);
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
      _areas = null;
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
      const turnout = _mode === 'turnout';
      const legend = turnout
        ? TURNOUT_CLASSES.map((entry) => ({
            label: t(TURNOUT_LABELS[entry.id]),
            color: entry.color,
            count: _districts.filter(
              (district) => turnoutClass(district.t)?.id === entry.id,
            ).length,
          }))
        : [...PARTIES, OTHER_PARTIES]
            .map((party) => ({
              label: party === OTHER_PARTIES ? t('Other') : party.id,
              color: party.color,
              count: _districts.filter(
                (district) => leadingParty(district.s) === party,
              ).length,
            }))
            .filter((entry) => entry.label !== t('Other'));
      const blurb = turnout
        ? t(
            'Districts coloured by turnout in the 2026 Riksdag election. Click a district for every party’s share.',
          )
        : t(
            'Districts coloured by their largest party in the 2026 Riksdag election. Click a district for every party’s share.',
          );
      const shown = legend.filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'party',
            label: t('LARGEST PARTY'),
            active: !turnout,
            title: t('Colour districts by their largest party'),
            onClick: () => setMode('party'),
          },
          {
            id: 'turnout',
            label: t('TURNOUT'),
            active: turnout,
            title: t('Colour districts by turnout'),
            onClick: () => setMode('turnout'),
          },
        ],
        legend: shown.map((item, index) =>
          index === 0 ? { ...item, blurb } : item,
        ),
        info: _tooHigh
          ? t('Zoom in below 120 km to see the election districts.')
          : _capped
            ? t('The {count} districts nearest the centre are shown.', {
                count: _districts.length,
              })
            : '',
      };
    },

    /** Select a district by its code, while it is shown. */
    setParams(params = {}) {
      const district = _byCode.get(String(params.districtCode ?? ''));
      if (!_enabled || !district) return false;
      select(district);
      return true;
    },

    /** The shown district containing a point, or null (tools and tests). */
    districtAt(point) {
      for (const district of _districts) {
        const [w, s, e, n] = district.b;
        if (point[0] < w || point[0] > e || point[1] < s || point[1] > n)
          continue;
        if (polygonsContain(_shapes.get(district.c) ?? [], point))
          return district;
      }
      return null;
    },

    getStats() {
      return {
        count: _districts.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
