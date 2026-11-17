import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { WARNING_LEVELS, levelColor } from './records.js';
import { CRISIS_KINDS } from './crisis.js';
import { spreadAroundPlaces } from '../policeEvents/records.js';
import {
  LEVEL_TITLES,
  SMHI_WARNINGS_OVERLAY_SOURCE_ID,
  SMHI_WARNINGS_PAGE,
  buildCrisisCard,
  buildWarningCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export * from './crisis.js';
export { createSmhiWarningsSource } from './source.js';

export const SMHI_WARNINGS_LAYER_ID = 'smhi-warnings';
/**
 * The draw sets the layer draws in, one per kind of thing drawn: the
 * warning areas' fills, their edges, and the crisis messages' dots on top.
 */
export const SMHI_WARNING_FILLS_SET_ID = `${SMHI_WARNINGS_LAYER_ID}:fills`;
export const SMHI_WARNING_EDGES_SET_ID = `${SMHI_WARNINGS_LAYER_ID}:edges`;
export const SMHI_CRISIS_DOTS_SET_ID = `${SMHI_WARNINGS_LAYER_ID}:crisis`;
const PICK_PREFIX = 'se-smhiwarn:';
const CRISIS_PICK_PREFIX = 'se-krisinfo:';
const CRISIS_LABELS = Object.freeze({
  vma: msg('VMA (important public announcement)'),
  news: msg('Crisis information'),
});
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** The ring around every crisis dot. */
const CRISIS_OUTLINE = '#ffffff';

/** A CSS colour at `alpha`, as a renderer colour made once per both. */
const _colors = new Map();
function colorAt(css, alpha) {
  const key = `${css}|${alpha}`;
  let color = _colors.get(key);
  if (!color) {
    const [r, g, b] = cssColor(css);
    color = Object.freeze([r, g, b, alpha]);
    _colors.set(key, color);
  }
  return color;
}

/** Vertex average of a polygon's largest outer ring: where its card stands. */
function anchorOf(row) {
  let ring = null;
  for (const polygon of row.polygons)
    if (!ring || polygon.outer.length > ring.length) ring = polygon.outer;
  if (!ring?.length) return null;
  const sum = ring.reduce(
    (acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat],
    [0, 0],
  );
  return [sum[0] / ring.length, sum[1] / ring.length];
}

const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));

/**
 * Own one Swedish weather warning display: SMHI's impact-based warnings as
 * areas coloured by level (yellow, orange, red; messages behind a toggle),
 * paler while they have yet to start, plus Krisinformation.se's VMAs and
 * crisis news as points (KRISINFO), with click-to-card selection. Share
 * links carry it as token 0y.
 */
export function createSmhiWarningsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SMHI warnings require a snapshot source');
  // With ground heights the crisis dots clamp to terrain only (see
  // groundHeights.js); the warning areas stay ground-clamped, which is cheap.
  // A dot spread around its place keeps the place's height.
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  let _viewer = null;
  /** The draw sets: area fills, area edges, crisis dots. */
  let _fills = null;
  let _edges = null;
  let _dots = null;
  /** The crisis messages drawn now. */
  let _drawnCrisis = new Set();
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _selectedCardId = null;
  let _areas = [];
  let _crisis = [];
  const _show = { messages: false, upcoming: true, crisis: true };
  const _areaById = new Map();
  const _crisisById = new Map();
  /** Crisis items sharing a place (often the whole country) spread ~20 km apart. */
  let _crisisPositions = new Map();
  const crisisPoint = (row) => _crisisPositions.get(row.id) || row.point;
  const crisisPosition = (row) => {
    const [lon, lat] = crisisPoint(row);
    return { lon, lat, height: _ground.heightOf(row.id) };
  };
  const visibleCrisis = () => (_show.crisis ? _crisis : []);

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(SMHI_WARNINGS_LAYER_ID);
  const visibleAreas = () =>
    _areas.filter(
      (row) =>
        (row.level !== 'MESSAGE' || _show.messages) &&
        (!row.upcoming || _show.upcoming),
    );

  function publishSelectedCard() {
    if (!canSelect()) return;
    const crisis = _selectedId ? _crisisById.get(_selectedId) : null;
    if (crisis) {
      const card = buildCrisisCard(crisis, { linkable: Boolean(openExternal) });
      const at = crisisPosition(crisis);
      card.position = fromDegrees(at.lon, at.lat, at.height);
      if (card.accessibilityLabel) {
        card.activate = () => {
          openExternal(crisis.link);
          return true;
        };
      }
      _selectedCardId = card.id;
      overlayHost.setEntries(
        SMHI_WARNINGS_OVERLAY_SOURCE_ID,
        [card],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const row = _selectedId ? _areaById.get(_selectedId) : null;
    const anchor = row && anchorOf(row);
    if (!row || !anchor) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        SMHI_WARNINGS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildWarningCard(row, { linkable: Boolean(openExternal) });
    card.position = fromDegrees(anchor[0], anchor[1]);
    if (card.accessibilityLabel) {
      card.activate = () => {
        openExternal(SMHI_WARNINGS_PAGE);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SMHI_WARNINGS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a pick id to an area or crisis id of this layer, or null. */
  function pickedArea(pickId) {
    if (typeof pickId === 'string' && pickId.startsWith(CRISIS_PICK_PREFIX)) {
      const crisisId = pickId.slice(CRISIS_PICK_PREFIX.length);
      return _crisisById.has(crisisId) ? crisisId : null;
    }
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    // Area ids are "<warning>:<area>"; the item suffix is the last segment.
    const id = pickId
      .slice(PICK_PREFIX.length)
      .split(':')
      .slice(0, -1)
      .join(':');
    return _areaById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Like the road layer, deliberately NOT registered in the pick-ownership
    // registry: large areas would otherwise make sibling cards inert.
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
      if (
        cardHit?.sourceId === SMHI_WARNINGS_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      ) {
        const crisis = _crisisById.get(_selectedId);
        const link = crisis ? crisis.link : SMHI_WARNINGS_PAGE;
        if (openExternal && link) openExternal(link);
      }
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedArea(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SMHI_WARNINGS_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(SMHI_WARNINGS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(SMHI_WARNINGS_OVERLAY_SOURCE_ID, false);
    }
  }

  /** A crisis message's dot as the set draws it: a VMA large, news smaller. */
  const dotOf = (row) => {
    const vma = row.kind === 'vma';
    return {
      id: `${CRISIS_PICK_PREFIX}${row.id}`,
      pos: crisisPosition(row),
      height: 'clampGround',
      pixelSize: vma ? 16 : 11,
      color:
        CRISIS_KINDS.find((kind) => kind.id === row.kind)?.color || '#40c4ff',
      outlineColor: CRISIS_OUTLINE,
      outlineWidth: vma ? 3 : 2,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  /** New ground heights: the crisis dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids
      .filter((id) => _drawnCrisis.has(id))
      .map((id) => _crisisById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Least severe first, so red is drawn over orange over yellow.
    const fills = [];
    const edges = [];
    for (const row of visibleAreas()) {
      const css = levelColor(row.level);
      const fill = colorAt(css, row.upcoming ? 0.12 : 0.3);
      const edge = row.upcoming
        ? { kind: 'dash', color: colorAt(css, 0.85), length: 16 }
        : { kind: 'solid', color: colorAt(css, 0.9) };
      const widthPx = row.level === 'MESSAGE' ? 1.5 : 2.5;
      row.polygons.forEach((polygon, index) => {
        fills.push({
          id: `${PICK_PREFIX}${row.id}:fill${index}`,
          geometry: {
            kind: 'polygon',
            rings: [polygon.outer, ...polygon.holes].map(ringDegrees),
          },
          fill,
          height: 'clampGround',
        });
        edges.push({
          id: `${PICK_PREFIX}${row.id}:edge${index}`,
          positions: [...polygon.outer, polygon.outer[0]].map(([lon, lat]) =>
            fromDegrees(lon, lat),
          ),
          widthPx,
          mode: 'draped',
          style: edge,
        });
      });
    }
    // Crisis messages on top of the areas.
    const crisis = visibleCrisis();
    _crisisPositions = spreadAroundPlaces(crisis, 20_000);
    _drawnCrisis = new Set();
    _fills.set(fills);
    _edges.set(edges);
    _dots.set(crisis.map(dotOf));
    _drawnCrisis = new Set(crisis.map((row) => row.id));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    if (
      _selectedId &&
      !visibleAreas().some((row) => row.id === _selectedId) &&
      !visibleCrisis().some((row) => row.id === _selectedId)
    )
      _selectedId = null;
    render();
    if (!_selectedId) publishSelectedCard();
    _rowListener?.();
  }

  const sets = () => [_fills, _edges, _dots];

  const layer = {
    id: SMHI_WARNINGS_LAYER_ID,
    name: 'Weather Warnings (Sweden)',
    icon: '⚠️',
    source: 'SMHI',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('SMHI warnings layer is already initialized');
      _viewer = viewer;
      const draw = drawOf(viewer);
      // The areas lie on every surface, terrain and 3D tiles both.
      _fills = draw.shapes({
        id: SMHI_WARNING_FILLS_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _edges = draw.lines({
        id: SMHI_WARNING_EDGES_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _dots = draw.points({
        id: SMHI_CRISIS_DOTS_SET_ID,
        // Terrain only once the dots have their ground heights: clamping
        // dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      for (const set of sets()) if (set) set.show = true;
      overlayHost?.setVisible?.(SMHI_WARNINGS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
      for (const set of sets()) if (set) set.show = false;
      removeClickHandler();
      clearSelection();
      requestRender();
    },

    async update() {
      if (!_enabled || !_dots) return false;
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
            : now();
        _lastError = null;
        const signature = JSON.stringify(
          snapshot.areas
            .map((row) => [
              row.id,
              row.level,
              row.start,
              row.end,
              row.upcoming,
              row.published,
            ])
            .concat(
              (snapshot.crisis || []).map((row) => [row.id, row.updated]),
            ),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          _areas = snapshot.areas;
          _areaById.clear();
          for (const row of _areas) _areaById.set(row.id, row);
          _crisis = snapshot.crisis || [];
          _crisisById.clear();
          for (const row of _crisis) _crisisById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_crisis);
          try {
            render();
          } catch (e) {
            console.warn('[Data:SmhiWarnings] Draw error:', e?.message || e);
            _lastError = e?.message || msg('SMHI warnings unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(
            `[Data:SmhiWarnings] Updated: ${_areas.length} warning areas, ${_crisis.length} crisis messages`,
          );
        } else {
          if (_selectedId) publishSelectedCard();
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_crisis);
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SmhiWarnings] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('SMHI warnings unavailable');
        _stale = false;
        _rowListener?.();
        // Enabling succeeded; the row reports the failure and the next
        // interval retries.
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _ground.clear();
      _areaById.clear();
      _areas = [];
      _crisisById.clear();
      _crisis = [];
      _crisisPositions = new Map();
      _drawnCrisis = new Set();
      _signature = null;
      for (const set of sets()) set?.dispose();
      _fills = null;
      _edges = null;
      _dots = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const shown = visibleAreas();
      const legend = [...WARNING_LEVELS]
        .reverse()
        .map(({ code, color }) => ({
          label: t(LEVEL_TITLES[code]),
          color,
          count: shown.filter((row) => row.level === code).length,
        }))
        .filter((item) => item.count > 0);
      for (const { id, color } of [...CRISIS_KINDS].reverse()) {
        const count = visibleCrisis().filter((row) => row.kind === id).length;
        if (count)
          legend.unshift({ label: t(CRISIS_LABELS[id]), color, count });
      }
      if (!legend.length)
        legend.push({
          label: t('No warnings in effect'),
          color: '#4caf50',
          count: 0,
        });
      return {
        chips: [
          {
            id: 'messages',
            label: t('MESSAGES'),
            active: _show.messages,
            title: t(
              'Also show SMHI messages, such as risk of water shortage, high flows or fire risk',
            ),
            onClick: () => toggle('messages'),
          },
          {
            id: 'upcoming',
            label: t('UPCOMING'),
            active: _show.upcoming,
            title: t('Also show warnings that have yet to start, drawn paler'),
            onClick: () => toggle('upcoming'),
          },
          {
            id: 'crisis',
            label: t('CRISIS INFO'),
            active: _show.crisis,
            title: t(
              'Also show VMAs and crisis news from Krisinformation.se (in Swedish), placed at the municipality or county they name',
            ),
            onClick: () => toggle('crisis'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Areas are SMHI’s impact-based weather warnings, coloured by level; paler areas start later. Click an area for what happens and what to think about.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      const shown = visibleAreas();
      return {
        count: shown.length,
        areas: _areas.length,
        red: shown.filter((row) => row.level === 'RED').length,
        orange: shown.filter((row) => row.level === 'ORANGE').length,
        vma: visibleCrisis().filter((row) => row.kind === 'vma').length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
