import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  INCIDENT_KINDS,
  OTHER_INCIDENT,
  ROAD_CONDITION_CODES,
  UNKNOWN_CONDITION_COLOR,
  conditionColor,
  incidentColor,
} from './records.js';
import {
  ROAD_OVERLAY_SOURCE_ID,
  buildConditionCard,
  buildIncidentCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createTrafikverketRoadsSource } from './source.js';

export const TRAFIKVERKET_ROADS_LAYER_ID = 'trafikverket-roads';
/**
 * The draw sets the layer draws in, one per kind of thing drawn: the
 * stretches of road condition, the incidents' dashed stretches, and the
 * incidents' dots on top.
 */
export const ROAD_CONDITION_LINES_SET_ID = `${TRAFIKVERKET_ROADS_LAYER_ID}:conditions`;
export const ROAD_INCIDENT_LINES_SET_ID = `${TRAFIKVERKET_ROADS_LAYER_ID}:incident-lines`;
export const ROAD_INCIDENT_DOTS_SET_ID = `${TRAFIKVERKET_ROADS_LAYER_ID}:incidents`;
const PICK_PREFIX = 'se-road:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const CONDITION_LABELS = Object.freeze({
  1: msg('Normal'),
  2: msg('Difficult (risk of)'),
  3: msg('Very difficult'),
  4: msg('Ice and snow surface'),
});
const KIND_LABELS = Object.freeze({
  accident: msg('Accident'),
  closure: msg('Road closed'),
  obstacle: msg('Obstacle'),
  roadwork: msg('Roadwork'),
  important: msg('Important traffic info'),
  restriction: msg('Restriction'),
  ferry: msg('Ferry'),
  message: msg('Traffic message'),
  minor: msg('Speed limits and lane closures'),
  other: msg('Other'),
});
/** The ring around a closed road's white dot and its dashed stretch. */
const CLOSURE_RING = '#ff1744';
/** The ring around every other incident's dot. */
const DOT_OUTLINE = Object.freeze([0, 0, 0, 0.8]);
/** Point size by Trafikverket SeverityCode (1, 2, 4, 5; higher is worse). */
const severityPixels = (severity) =>
  ({ 5: 15, 4: 13, 2: 10, 1: 8 })[severity] || 9;
const conditionWidth = (code) => ({ 3: 6, 2: 4, 4: 4, 1: 2 })[code] || 3;

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

/**
 * Own one Swedish road display: winter road condition per stretch and live
 * incidents from Trafikverket, with click-to-card selection. Share links
 * carry it as token 0j.
 */
export function createTrafikverketRoadsLayer({
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
    throw new TypeError('Trafikverket roads require a snapshot source');
  // With ground heights the incident dots clamp to terrain only (see
  // groundHeights.js); road lines stay ground-clamped, which is cheap.
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  let _viewer = null;
  /** The draw sets: condition stretches, incident stretches, incident dots. */
  let _conditionLines = null;
  let _incidentLines = null;
  let _dots = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  /**
   * What is on the map: "c:<id>" or "i:<id>" → {print, its line items, the
   * id of its dot or null}.
   */
  const _drawn = new Map();
  /** The next drawing starts over: the first one, and after one that failed. */
  let _redrawAll = true;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selected = null;
  let _selectedCardId = null;
  let _conditions = [];
  let _incidents = [];
  const _show = {
    conditions: true,
    normal: false,
    incidents: true,
    minor: false,
  };
  const _conditionById = new Map();
  const _incidentById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(TRAFIKVERKET_ROADS_LAYER_ID);

  function selectedRow() {
    if (!_selected) return null;
    return _selected.kind === 'c'
      ? _conditionById.get(_selected.id)
      : _incidentById.get(_selected.id);
  }

  function anchorOf(row) {
    if (row.point) return row.point;
    const line = row.lines?.[0];
    return line ? line[Math.floor(line.length / 2)] : null;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = selectedRow();
    const anchor = row && anchorOf(row);
    if (!row || !anchor) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(ROAD_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card =
      _selected.kind === 'c'
        ? buildConditionCard(row)
        : buildIncidentCard(row, { linkable: Boolean(openExternal) });
    card.position = fromDegrees(
      anchor[0],
      anchor[1],
      _selected.kind === 'i' ? _ground.heightOf(row.id) : 0,
    );
    if (card.accessibilityLabel && row.link) {
      card.activate = () => {
        openExternal(row.link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(ROAD_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** Resolve a pick id to {kind, id} of this layer, or null. */
  function pickedRow(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [kind, ...rest] = pickId.slice(PICK_PREFIX.length).split(':');
    // Ids may themselves contain ':'; the item suffix is the last segment.
    const id = rest.length > 1 ? rest.slice(0, -1).join(':') : rest[0];
    const map = kind === 'c' ? _conditionById : _incidentById;
    return map.has(id) ? { kind, id } : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Like fire perimeters, deliberately NOT registered in the pick-ownership
    // registry: long road lines would otherwise make sibling cards inert.
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
        cardHit?.sourceId === ROAD_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      ) {
        const row = selectedRow();
        if (row?.link && openExternal) openExternal(row.link);
      }
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedRow(pickId);
      if (hit) {
        _selected = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(TRAFIKVERKET_ROADS_LAYER_ID, pickId)
      )
        return;
      if (_selected) {
        _selected = null;
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
    _selected = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(ROAD_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(ROAD_OVERLAY_SOURCE_ID, false);
    }
  }

  const positions = (line) => line.map(([lon, lat]) => fromDegrees(lon, lat));

  /** An incident's dot as the set draws it. */
  const dotOf = (row) => {
    const closure = row.kind === 'closure';
    return {
      id: `${PICK_PREFIX}i:${row.id}:point`,
      pos: {
        lon: row.point[0],
        lat: row.point[1],
        height: _ground.heightOf(row.id),
      },
      height: 'clampGround',
      pixelSize: row.kind === 'minor' ? 6 : severityPixels(row.severity),
      color: incidentColor(row.kind),
      outlineColor: closure ? CLOSURE_RING : DOT_OUTLINE,
      outlineWidth: closure ? 3 : 1.5,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  /** New ground heights: the incident dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const dots = [];
    for (const id of ids) {
      const row = _incidentById.get(id);
      if (row && _drawn.get(`i:${id}`)?.dot) dots.push(dotOf(row));
    }
    if (dots.length) _dots.upsert(dots);
    if (_selected?.kind === 'i' && ids.includes(_selected.id))
      publishSelectedCard();
    requestRender();
  }

  /** A cheap fingerprint of every vertex a row draws. */
  const geometryPrint = (lines) => {
    let hash = lines.length;
    for (const line of lines) {
      hash = (hash * 31 + line.length) | 0;
      for (const [lon, lat] of line) {
        hash = (hash * 31 + Math.round(lon * 1e5)) | 0;
        hash = (hash * 31 + Math.round(lat * 1e5)) | 0;
      }
    }
    return hash;
  };

  /** One road-condition stretch as the sets draw it. */
  function drawCondition(row) {
    const color = colorAt(
      conditionColor(row.code),
      row.code === 1 ? 0.55 : 0.9,
    );
    return {
      lines: row.lines.map((line, index) => ({
        id: `${PICK_PREFIX}c:${row.id}:${index}`,
        positions: positions(line),
        widthPx: conditionWidth(row.code),
        mode: 'draped',
        style: { kind: 'solid', color },
      })),
      dot: null,
    };
  }

  /** One incident, its stretch and its dot, as the sets draw them. */
  function drawIncident(row) {
    const closure = row.kind === 'closure';
    // Dashed, so an incident's stretch never reads as a road condition.
    const color = colorAt(
      closure ? CLOSURE_RING : incidentColor(row.kind),
      0.8,
    );
    return {
      lines: row.lines.map((line, index) => ({
        id: `${PICK_PREFIX}i:${row.id}:line${index}`,
        positions: positions(line),
        widthPx: closure ? 4 : 3,
        mode: 'draped',
        style: { kind: 'dash', color, length: 14 },
      })),
      dot: dotOf(row),
    };
  }

  /**
   * What the toggles leave on the map: key → the row, how to draw it and a
   * fingerprint of everything its drawing depends on.
   */
  function wantedRows() {
    const wanted = new Map();
    if (_show.conditions)
      for (const row of _conditions) {
        if (row.code === 1 && !_show.normal) continue;
        wanted.set(`c:${row.id}`, {
          row,
          draw: drawCondition,
          print: `${row.code}|${geometryPrint(row.lines)}`,
        });
      }
    if (_show.incidents)
      for (const row of _incidents) {
        if (row.kind === 'minor' && !_show.minor) continue;
        wanted.set(`i:${row.id}`, {
          row,
          draw: drawIncident,
          print: `${row.kind}|${row.severity}|${row.point}|${geometryPrint(row.lines)}`,
        });
      }
    return wanted;
  }

  /** Every line item drawn now of the rows whose key starts with `kind`. */
  function drawnLines(kind) {
    const lines = [];
    for (const [key, drawn] of _drawn)
      if (key.startsWith(kind)) lines.push(...drawn.lines);
    return lines;
  }

  /**
   * Bring the map in line with the rows and the toggles. In place: a row that
   * is drawn as it should be is left alone, so one new incident among
   * thousands adds one dot instead of drawing the whole country again, and a
   * set of lines none of whose rows changed is not written at all.
   * @returns {number} How many rows were added, removed or drawn anew.
   */
  function render() {
    if (!_dots) return 0;
    const wanted = wantedRows();
    let touched = 0;
    const full = _redrawAll;
    // Until this drawing is done: one that fails is made again from scratch.
    _redrawAll = true;
    if (full) {
      _drawn.clear();
      for (const [key, item] of wanted)
        _drawn.set(key, { print: item.print, ...item.draw(item.row) });
      _conditionLines.set(drawnLines('c:'));
      _incidentLines.set(drawnLines('i:'));
      const dots = [];
      for (const drawn of _drawn.values()) if (drawn.dot) dots.push(drawn.dot);
      _dots.set(dots);
      touched = wanted.size;
    } else {
      // Gone and changed rows leave, then new and changed ones come; the
      // dots change where they are, a set of lines is written once, whole.
      const linesChanged = { c: false, i: false };
      const goneDots = [];
      for (const [key, drawn] of _drawn)
        if (wanted.get(key)?.print !== drawn.print) {
          if (drawn.lines.length) linesChanged[key[0]] = true;
          if (drawn.dot) goneDots.push(drawn.dot.id);
          _drawn.delete(key);
          touched += 1;
        }
      const newDots = [];
      for (const [key, item] of wanted)
        if (!_drawn.has(key)) {
          const drawn = { print: item.print, ...item.draw(item.row) };
          _drawn.set(key, drawn);
          if (drawn.lines.length) linesChanged[key[0]] = true;
          if (drawn.dot) newDots.push(drawn.dot);
          touched += 1;
        }
      if (goneDots.length) _dots.remove(goneDots);
      if (newDots.length) _dots.upsert(newDots);
      if (linesChanged.c) _conditionLines.set(drawnLines('c:'));
      if (linesChanged.i) _incidentLines.set(drawnLines('i:'));
    }
    _redrawAll = false;
    // A row the toggles or Trafikverket took off the map keeps no card.
    if (_selected && !_drawn.has(`${_selected.kind}:${_selected.id}`))
      _selected = null;
    if (_selected || _selectedCardId) publishSelectedCard();
    requestRender();
    return touched;
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const sets = () => [_conditionLines, _incidentLines, _dots];

  const layer = {
    id: TRAFIKVERKET_ROADS_LAYER_ID,
    name: 'Road Conditions (Sweden)',
    icon: '🛣️',
    source: 'Trafikverket',
    updateInterval: 180000,

    init(viewer) {
      if (_viewer)
        throw new Error('Trafikverket roads layer is already initialized');
      _viewer = viewer;
      const draw = drawOf(viewer);
      // Road lines drape on every surface, as ground-clamped lines did.
      _conditionLines = draw.lines({
        id: ROAD_CONDITION_LINES_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _incidentLines = draw.lines({
        id: ROAD_INCIDENT_LINES_SET_ID,
        clampTo: 'both',
        show: false,
      });
      _dots = draw.points({
        id: ROAD_INCIDENT_DOTS_SET_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      for (const set of sets()) if (set) set.show = true;
      overlayHost?.setVisible?.(ROAD_OVERLAY_SOURCE_ID, true);
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
        // Always the newest rows, so a card reads the text Trafikverket has
        // now; the map itself changes only where a row did.
        _conditions = snapshot.conditions;
        _incidents = snapshot.incidents;
        _conditionById.clear();
        _incidentById.clear();
        for (const row of _conditions) _conditionById.set(row.id, row);
        for (const row of _incidents) _incidentById.set(row.id, row);
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_incidents);
        let touched;
        try {
          touched = render();
        } catch (e) {
          console.warn('[Data:TrafikverketRoads] Draw error:', e?.message || e);
          _lastError = e?.message || msg('Trafikverket feed unavailable');
          _rowListener?.();
          return true;
        }
        if (touched)
          console.log(
            `[Data:TrafikverketRoads] Updated: ${_conditions.length} stretches, ${_incidents.length} incidents (${touched} drawn or removed)`,
          );
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:TrafikverketRoads] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Trafikverket feed unavailable');
        _stale = false;
        _rowListener?.();
        // Enabling succeeded; the row reports the failure and the next
        // interval retries. A missing key keeps the layer on, explained.
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _ground.clear();
      _conditionById.clear();
      _incidentById.clear();
      _conditions = [];
      _incidents = [];
      _drawn.clear();
      _redrawAll = true;
      for (const set of sets()) set?.dispose();
      _conditionLines = null;
      _incidentLines = null;
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
      const codeCount = (code) =>
        _conditions.filter((row) => row.code === code).length;
      const kindCount = (kind) =>
        _incidents.filter((row) => row.kind === kind).length;
      const conditionLegend = Object.entries(ROAD_CONDITION_CODES)
        .filter(([code]) => Number(code) !== 1 || _show.normal)
        .map(([code, { color }]) => ({
          label: t(CONDITION_LABELS[code]),
          color,
          count: codeCount(Number(code)),
        }));
      const unknown = _conditions.filter(
        (row) => !ROAD_CONDITION_CODES[row.code],
      ).length;
      if (unknown)
        conditionLegend.push({
          label: t('Other condition'),
          color: UNKNOWN_CONDITION_COLOR,
          count: unknown,
        });
      const incidentLegend = [...INCIDENT_KINDS, OTHER_INCIDENT]
        .filter(({ id }) => id !== 'minor' || _show.minor)
        .map(({ id, color }) => ({
          label: t(KIND_LABELS[id]),
          color,
          count: kindCount(id),
        }))
        .filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'conditions',
            label: t('ROAD CONDITION'),
            active: _show.conditions,
            title: t(
              'Winter road surface per stretch; Trafikverket publishes it 1 November to 30 April',
            ),
            onClick: () => toggle('conditions'),
          },
          {
            id: 'normal',
            label: t('INCL. NORMAL'),
            active: _show.normal,
            disabled: !_show.conditions,
            title: t('Also draw stretches with normal road condition'),
            onClick: () => toggle('normal'),
          },
          {
            id: 'incidents',
            label: t('INCIDENTS'),
            active: _show.incidents,
            title: t(
              'Accidents, roadworks, obstacles and restrictions in effect now',
            ),
            onClick: () => toggle('incidents'),
          },
          {
            id: 'minor',
            label: t('INCL. MINOR'),
            active: _show.minor,
            disabled: !_show.incidents,
            title: t(
              'Also show speed limits, lane closures, overtaking bans and weight limits at roadworks',
            ),
            onClick: () => toggle('minor'),
          },
        ],
        legend: [
          ...(_show.conditions ? conditionLegend : []),
          ...(_show.incidents ? incidentLegend : []),
        ].map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Lines show road condition, dots show incidents; dot size follows severity. Click either for details.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      const problems = _conditions.filter((row) => row.code !== 1).length;
      const shownIncidents = _show.minor
        ? _incidents.length
        : _incidents.filter((row) => row.kind !== 'minor').length;
      return {
        count:
          (_show.conditions ? problems : 0) +
          (_show.incidents ? shownIncidents : 0),
        conditions: _conditions.length,
        incidents: _incidents.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
