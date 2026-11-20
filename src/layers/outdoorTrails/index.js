import { formatNumber, msg, onLocaleChange, t } from '../../i18n/index.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { analystRows } from '../analystRows.js';
import {
  FACILITY_CLASS,
  FACILITY_CLASSES,
  TRAIL_CLASS,
  TRAIL_CLASSES,
  clipOutdoorBox,
  decodeLine,
} from './records.js';
import {
  FACILITY_LABELS,
  OUTDOOR_TRAILS_OVERLAY_SOURCE_ID,
  TRAIL_LABELS,
  buildFacilityCard,
  buildTrailCard,
  facilityName,
  trailName,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createOutdoorTrailsSource } from './source.js';

export const OUTDOOR_TRAILS_LAYER_ID = 'outdoor-trails';
export const OUTDOOR_TRAILS_LINES_SET_ID = `${OUTDOOR_TRAILS_LAYER_ID}:trails`;
export const OUTDOOR_TRAILS_POINTS_SET_ID = `${OUTDOOR_TRAILS_LAYER_ID}:facilities`;
const PICK_PREFIX = 'se-outdoor:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Trails and facilities show below this camera height; above it, a hint. */
export const OUTDOOR_MAX_HEIGHT_M = 30_000;
/** The nearest this many facilities to the map centre are drawn. */
const SHOWN = 1500;
const MOVE_SETTLE_MS = 400;
const OUTLINE_COLOR = '#1b1b1b';
const TRAIL_WIDTH = 2.5;
const SELECTED_TRAIL_WIDTH = 5;
const SCALE_BY_DISTANCE = Object.freeze({
  near: 300,
  nearValue: 1.3,
  far: 20000,
  farValue: 0.7,
});

/** A CSS colour at `alpha`, as a renderer colour made once. */
/**
 * The register's type words that add something to a row's kind, joined, or
 * null: a facility whose type and subtype are both "Vindskydd" says it once,
 * and not at all when its kind already says it.
 */
function otherWords(kind, words) {
  const seen = new Set([String(kind ?? '').toLowerCase()]);
  const kept = [];
  for (const word of words) {
    const key = String(word ?? '')
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(String(word).trim());
  }
  return kept.join(' · ') || null;
}

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

/**
 * Own one display of Sweden's trails and outdoor facilities: the trails and
 * facilities Naturvårdsverket publishes for protected areas, and the state
 * mountain trails, drawn for the view once the camera is low enough — trails
 * as lines, facilities as dots, the nearest to the centre first — with a card
 * for a clicked one. The rows come from a snapshot of Naturvårdsverket's
 * download files built by hand (scripts/build-outdoor-trails.mjs), served per
 * view by /api/outdoor-trails. Share links carry it as token 14.
 */
export function createOutdoorTrailsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Outdoor trails require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids), {
    passing: true,
  });
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  let _viewer = null;
  let _lines = null;
  let _dots = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _zoomIn = true;
  let _capped = false;
  let _facilityTotal = null;
  let _trailTotal = null;
  /** {kind: 'f'|'t', id} of the selected row, or null. */
  let _selected = null;
  let _offLocale = null;
  let _facilities = [];
  let _trails = [];
  const _facilityById = new Map();
  const _trailById = new Map();
  /** Decoded lines per trail id, for drawing. */
  const _linesById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(OUTDOOR_TRAILS_LAYER_ID);

  /** A facility's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}f:${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: row.kind === 'shelter' ? 9 : 7,
    color: FACILITY_CLASS[row.kind]?.color ?? FACILITY_CLASS.other.color,
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  /** A trail's lines as the set draws them, wider when selected. */
  const trailLinesOf = (row) => {
    const selected = _selected?.kind === 't' && _selected.id === row.id;
    const color = colorAt(
      TRAIL_CLASS[row.kind]?.color ?? TRAIL_CLASS.other.color,
      selected ? 1 : 0.85,
    );
    return (_linesById.get(row.id) ?? []).map((line, index) => ({
      id: `${PICK_PREFIX}t:${row.id}:${index}`,
      positions: line.map(([lon, lat]) => fromDegrees(lon, lat)),
      widthPx: selected ? SELECTED_TRAIL_WIDTH : TRAIL_WIDTH,
      mode: 'draped',
      style: { kind: 'solid', color },
    }));
  };

  const selectedRow = () =>
    _selected?.kind === 'f'
      ? _facilityById.get(_selected.id)
      : _selected?.kind === 't'
        ? _trailById.get(_selected.id)
        : null;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = selectedRow();
    if (!row) {
      _selected = null;
      overlayHost.setEntries(
        OUTDOOR_TRAILS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    let card;
    if (_selected.kind === 'f') {
      card = buildFacilityCard(row);
      const at = position(row);
      card.position = fromDegrees(at.lon, at.lat, at.height);
    } else {
      card = buildTrailCard(row);
      card.position = fromDegrees(row.anchor[0], row.anchor[1]);
    }
    overlayHost.setEntries(
      OUTDOOR_TRAILS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRow(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [kind, id] = pickId.slice(PICK_PREFIX.length).split(':');
    if (kind === 'f' && _facilityById.has(id)) return { kind, id };
    if (kind === 't' && _trailById.has(id)) return { kind, id };
    return null;
  }

  /** Select a row (or none): the card follows, a trail redraws wider. */
  function select(next) {
    const trailOf = (hit) =>
      hit?.kind === 't' ? (_trailById.get(hit.id) ?? null) : null;
    const before = trailOf(_selected);
    _selected = next;
    const after = trailOf(next);
    // Only the trail let go and the trail taken are drawn again: redrawing
    // every line in view on each click costs tens of thousands of points.
    const changed = [before, after].filter(
      (row, index, rows) => row && rows.indexOf(row) === index,
    );
    if (changed.length) _lines?.upsert(changed.flatMap(trailLinesOf));
    publishSelectedCard();
    requestRender();
    _rowListener?.();
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      OUTDOOR_TRAILS_LAYER_ID,
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
      const hit = pickedRow(pickId);
      if (hit) {
        select(hit);
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(OUTDOOR_TRAILS_LAYER_ID, pickId)
      )
        return;
      // The bare ground: one card at a time, and none now.
      if (_selected) select(null);
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(OUTDOOR_TRAILS_LAYER_ID);
  }

  function clearOverlays() {
    _selected = null;
    if (!overlayHost) return;
    overlayHost.clearSource(OUTDOOR_TRAILS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(OUTDOOR_TRAILS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids.map((id) => _facilityById.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    if (_selected?.kind === 'f' && ids.includes(_selected.id))
      publishSelectedCard();
    requestRender();
  }

  function drawTrails() {
    // Farthest first, so the nearest draw on top where lines meet.
    _lines?.set([..._trails].reverse().flatMap(trailLinesOf));
  }

  function render() {
    if (!_dots || !_lines) return;
    drawTrails();
    _dots.set([..._facilities].reverse().map(dotOf));
    if (_selected) publishSelectedCard();
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

  /** The view as a box and its centre, or null when the camera is too high. */
  function viewQuery() {
    const camera = _viewer ? findCamera(_viewer) : null;
    const pose = camera?.pose();
    const height = pose?.height;
    if (!Number.isFinite(height) || height > OUTDOOR_MAX_HEIGHT_M) return null;
    const rect = camera.viewRectangle?.();
    if (!rect) return null;
    const center = viewCentre() ?? [pose.lon, pose.lat];
    return {
      // A tilted view reaches the horizon: ask for the part about the centre.
      bbox: clipOutdoorBox(
        [rect.west, rect.south, rect.east, rect.north],
        center,
      ),
      center,
    };
  }

  /** Forget the view's rows: the camera is too high, or the layer off. */
  function clearRows() {
    _zoomIn = true;
    _capped = false;
    _facilities = [];
    _trails = [];
    _facilityTotal = null;
    _trailTotal = null;
    _facilityById.clear();
    _trailById.clear();
    _linesById.clear();
    _ground.cancel();
  }

  async function refresh() {
    if (!_enabled || !_dots) return false;
    _request?.abort();
    const query = viewQuery();
    if (!query) {
      _request = null;
      clearRows();
      if (_selected) publishSelectedCard();
      render();
      _rowListener?.();
      return true;
    }
    const request = new AbortController();
    _request = request;
    try {
      const snapshot = await source.getSnapshot({
        signal: request.signal,
        ...query,
        limit: SHOWN,
      });
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      _stale = snapshot.stale;
      // The snapshot's build date: the rows are as old as that.
      _lastUpdate = Number.isFinite(snapshot.fetchedAt)
        ? snapshot.fetchedAt
        : Date.now();
      _lastError = null;
      _zoomIn = snapshot.tooWide;
      _capped = snapshot.capped;
      _facilities = snapshot.tooWide ? [] : snapshot.facilities;
      _trails = snapshot.tooWide
        ? []
        : snapshot.trails.filter(
            (row) => Array.isArray(row?.anchor) && Array.isArray(row?.lines),
          );
      _facilityTotal = snapshot.facilityTotal;
      _trailTotal = snapshot.trailTotal;
      _facilityById.clear();
      _trailById.clear();
      _linesById.clear();
      for (const row of _facilities) _facilityById.set(row.id, row);
      for (const row of _trails) {
        _trailById.set(row.id, row);
        _linesById.set(
          row.id,
          row.lines.map(decodeLine).filter((line) => line.length >= 2),
        );
      }
      if (_selected && !selectedRow()) {
        _selected = null;
        publishSelectedCard();
      }
      _ground.place(_facilities);
      render();
      _rowListener?.();
      return true;
    } catch (e) {
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      console.warn('[Data:OutdoorTrails] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Trails unavailable');
      _stale = false;
      _rowListener?.();
      return true;
    } finally {
      if (_request === request) _request = null;
    }
  }

  function scheduleRefresh() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
  }

  /** The legend rows of one kind of row, those in view only. */
  const legendOf = (classes, labels, rows) =>
    classes
      .map((entry) => ({
        label: t(labels[entry.id]),
        color: entry.color,
        count: rows.filter((row) => row.kind === entry.id).length,
      }))
      .filter((item) => item.count > 0);

  const facilityLabel = (row) =>
    t('Facility · {name}', { name: facilityName(row) });
  const trailLabel = (row) => t('Trail · {name}', { name: trailName(row) });

  const layer = {
    id: OUTDOOR_TRAILS_LAYER_ID,
    name: 'Trails and outdoor facilities (Sweden)',
    icon: '🥾',
    source: 'Naturvårdsverket',
    updateInterval: 12 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Outdoor trails layer is already initialized');
      _viewer = viewer;
      const draw = drawOf(viewer);
      // Trails drape on every surface, as the road lines do.
      _lines = draw.lines({
        id: OUTDOOR_TRAILS_LINES_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _dots = draw.points({
        id: OUTDOOR_TRAILS_POINTS_SET_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
      // An open card follows the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selected) publishSelectedCard();
      });
    },

    enable() {
      _enabled = true;
      if (_lines) _lines.show = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(OUTDOOR_TRAILS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      _removeMove ??=
        (_viewer && findCamera(_viewer)?.on('moveEnd', scheduleRefresh)) ??
        null;
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
      if (_lines) _lines.show = false;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      clearRows();
      render();
    },

    update() {
      return refresh();
    },

    /** Select a shown facility or trail by its id (tools and tests). */
    setParams(params = {}) {
      if (!_enabled) return false;
      const hit = params.facilityId
        ? { kind: 'f', id: String(params.facilityId) }
        : params.trailId
          ? { kind: 't', id: String(params.trailId) }
          : null;
      if (!hit || !(hit.kind === 'f' ? _facilityById : _trailById).has(hit.id))
        return false;
      select(hit);
      return true;
    },

    destroy() {
      _offLocale?.();
      _offLocale = null;
      layer.disable();
      _ground.clear();
      _lines?.dispose();
      _dots?.dispose();
      _lines = null;
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
      if (_zoomIn)
        return {
          info: t(
            'Zoom in to see the trails and facilities: they show below {height} km',
            { height: OUTDOOR_MAX_HEIGHT_M / 1000 },
          ),
        };
      const blurb = t(
        'Lines are trails and dots are facilities (shelters, cabins, fireplaces, toilets, towers, parking) that Naturvårdsverket publishes for protected areas, plus the state mountain trails. Only published areas are covered, so much is missing. Reserve rules and access bans apply. Click one for its card.',
      );
      const legend = [
        ...legendOf(TRAIL_CLASSES, TRAIL_LABELS, _trails),
        ...legendOf(FACILITY_CLASSES, FACILITY_LABELS, _facilities),
      ].map((item, index) => (index === 0 ? { ...item, blurb } : item));
      return {
        legend,
        info:
          _facilityTotal === null && _trailTotal === null
            ? ''
            : _capped
              ? t('Zoom in to see every trail and facility here.')
              : t('In view: {trails} trails · {facilities} facilities', {
                  trails: formatNumber(_trailTotal ?? 0),
                  facilities: formatNumber(_facilityTotal ?? 0),
                }),
      };
    },

    /** What a picked trail or facility is called, and where it is. */
    findByQuery(pickId) {
      const hit = pickedRow(pickId);
      if (!hit) return null;
      if (hit.kind === 't') {
        const row = _trailById.get(hit.id);
        return {
          name: trailLabel(row),
          latitude: row.anchor[1],
          longitude: row.anchor[0],
        };
      }
      const row = _facilityById.get(hit.id);
      return {
        name: facilityLabel(row),
        latitude: row.point[1],
        longitude: row.point[0],
      };
    },

    /**
     * The trails and facilities shown, named as findByQuery names them: a
     * trail at its point nearest the centre, a facility where it stands.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const trails = analystRows(_trails, maxCount, {
        place: (row) => row.anchor,
        name: trailLabel,
        extra: (row) => ({
          // One type row: the register's own words, else the legend's group.
          kind:
            otherWords('', [row.type]) ??
            t(TRAIL_LABELS[row.kind] ?? TRAIL_LABELS.other),
          lengthKm: Number.isFinite(row.lengthKm) ? row.lengthKm : null,
          protectedArea: row.area ?? null,
          stateTrail: Boolean(row.stateTrail),
        }),
      });
      if (trails.length >= maxCount) return trails;
      const facilities = analystRows(_facilities, maxCount - trails.length, {
        name: facilityLabel,
        extra: (row) => ({
          kind:
            otherWords('', [row.type, row.subtype]) ??
            t(FACILITY_LABELS[row.kind] ?? FACILITY_LABELS.other),
          protectedArea: row.area ?? null,
          accessible: Boolean(row.accessible),
        }),
      });
      return [...trails, ...facilities];
    },

    getStats() {
      return {
        count: _zoomIn ? null : (_trailTotal ?? 0) + (_facilityTotal ?? 0),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
