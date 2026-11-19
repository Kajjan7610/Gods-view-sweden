import { msg, onLocaleChange, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import { FROST_CLASSES, frostClass, frostColor } from './records.js';
import {
  FROST_DEPTH_OVERLAY_SOURCE_ID,
  buildFrostDepthCard,
  frostLabel,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createFrostDepthSource } from './source.js';

export const FROST_DEPTH_LAYER_ID = 'frost-depth';
const PICK_PREFIX = 'se-frost:';
const OUTLINE_COLOR = '#ffffff';
const LABEL_SOURCE_ID = 'frost-depth-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 80,
  collisionCapacity: 40,
  moving: false,
});

/** The legend rows, by FROST_CLASSES id. */
const CLASS_LABELS = Object.freeze({
  none: msg('No frozen ground'),
  shallow: msg('Frozen to 30 cm'),
  moderate: msg('Frozen 30–80 cm'),
  deep: msg('Frozen 80–150 cm'),
  'very-deep': msg('Frozen deeper than 150 cm'),
});

/**
 * Own one Swedish frost depth display: Trafikverket's frost depth points as
 * dots coloured by how deep the ground is frozen, the depth beside each and
 * click-to-card selection with the ground's temperature by depth. Share
 * links carry it as token 12.
 */
export function createFrostDepthLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Frost depth requires a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  /** Where a card or label sits: the dot's place on the ellipsoid (ECEF). */
  const placeOf = (row) => {
    const at = position(row);
    return fromDegrees(at.lon, at.lat, at.height);
  };
  let _viewer = null;
  let _dots = null;
  /** The ids of the rows the set holds: the ones a new height can move. */
  let _drawn = new Set();
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _points = [];
  let _silent = 0;
  let _depths = true;
  let _offLocale = null;
  const _pointById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(FROST_DEPTH_LAYER_ID);

  /** A point's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: row.frost ? 12 : 8,
    color: frostColor(row.depth),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 2,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _pointById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        FROST_DEPTH_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildFrostDepthCard(row);
    card.position = placeOf(row);
    overlayHost.setEntries(
      FROST_DEPTH_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedPoint(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _pointById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      FROST_DEPTH_LAYER_ID,
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
      const hit = pickedPoint(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      // Another layer's item, or the bare ground: one card at a time.
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
    picking?.unregisterPickOwner?.(FROST_DEPTH_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    for (const id of [FROST_DEPTH_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _depths) {
      for (const row of _points) {
        if (!row.frost) continue;
        entries.push({
          id: `frost-depth-label:${row.id}`,
          position: placeOf(row),
          variant: 'label',
          title: frostLabel(row),
          accent: frostColor(row.depth),
          // The deepest frost wins the label budget.
          priority: row.depth,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 10,
          verticalOnly: true,
          placement: 'above',
        });
      }
    }
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids
      .filter((id) => _drawn.has(id))
      .map((id) => _pointById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    _dots.set(_points.map(dotOf));
    _drawn = new Set(_points.map((row) => row.id));
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: FROST_DEPTH_LAYER_ID,
    name: 'Frost depth (Sweden)',
    icon: '🧊',
    source: 'Trafikverket',
    updateInterval: 30 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Frost depth layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: FROST_DEPTH_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
      // An open card follows the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selectedId) publishSelectedCard();
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(FROST_DEPTH_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
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
        _silent = snapshot.silent;
        const signature = JSON.stringify(
          snapshot.points.map((row) => [row.id, row.sampledAt, row.depth]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          _points = snapshot.points;
          _pointById.clear();
          for (const row of _points) _pointById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_points);
          try {
            render();
          } catch (e) {
            console.warn('[Data:FrostDepth] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Frost depth unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(`[Data:FrostDepth] Updated: ${_points.length} points`);
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_points);
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:FrostDepth] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Frost depth unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _offLocale?.();
      _offLocale = null;
      _ground.clear();
      _pointById.clear();
      _points = [];
      _drawn = new Set();
      _signature = null;
      _dots?.dispose();
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
      const legend = FROST_CLASSES.map((entry) => ({
        label: t(CLASS_LABELS[entry.id]),
        color: entry.color,
        count: _points.filter((row) => frostClass(row.depth) === entry).length,
      })).filter((item) => item.count > 0);
      const blurb = [
        t(
          'Dots are Trafikverket’s frost rods in the road, coloured by how deep the road is frozen: where a string of sensors finds the temperature crossing 0 °C. Click a point for the temperature by depth.',
        ),
        _silent
          ? t('Left out, no report for two days: {count}.', {
              count: _silent,
            })
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        chips: [
          {
            id: 'depths',
            label: t('DEPTH'),
            active: _depths,
            title: t('Write the frost depth beside each point'),
            onClick: () => {
              _depths = !_depths;
              publishLabels();
              _rowListener?.();
            },
          },
        ],
        // With no point reporting (out of season), one row still says why.
        legend: (legend.length
          ? legend
          : [
              {
                label: t('No point is reporting'),
                color: FROST_CLASSES[0].color,
                count: 0,
              },
            ]
        ).map((item, index) => (index === 0 ? { ...item, blurb } : item)),
      };
    },

    /** The points, for the context panel's count in view and the analyst. */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled) return [];
      return _points.slice(0, Math.max(1, maxCount)).map((row) => ({
        id: row.id,
        name: t('Frost depth · {name}', { name: row.name }),
        lat: row.point[1],
        lon: row.point[0],
        frostDepthCm: row.frost ? row.frost.bottom : 0,
      }));
    },

    /** What a picked point is called, and where it is. */
    findByQuery(pickId) {
      const id = pickedPoint(pickId);
      if (!id) return null;
      const row = _pointById.get(id);
      return {
        name: t('Frost depth · {name}', { name: row.name }),
        latitude: row.point[1],
        longitude: row.point[0],
      };
    },

    getStats() {
      return {
        count: _points.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
