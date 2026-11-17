import { formatNumber, msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  classOf,
  meanWaterLevel,
} from './records.js';
import {
  SEA_WEATHER_OVERLAY_SOURCE_ID,
  buildSeaCard,
  seaColor,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSeaWeatherSource } from './source.js';

export const SEA_WEATHER_LAYER_ID = 'sea-weather';
const PICK_PREFIX = 'se-sea:';
const OUTLINE_COLOR = '#0d47a1';
/** A palette colour at `alpha`, as the renderer takes it. */
const withAlpha = (css, alpha) => {
  const [r, g, b] = cssColor(css);
  return [r, g, b, alpha];
};
const LABEL_SOURCE_ID = 'sea-weather-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 400,
  collisionCapacity: 40,
  moving: false,
});
const LEVEL_LABELS = Object.freeze({
  'very-low': msg('40 cm or more below mean'),
  low: msg('10 to 40 cm below mean'),
  normal: msg('Within 10 cm of mean'),
  high: msg('10 to 40 cm above mean'),
  'very-high': msg('40 cm or more above mean'),
});

/**
 * Own one Swedish sea weather display: SMHI's ocean stations coloured by
 * water level against mean water, with the level written beside the
 * stations furthest off it and click-to-card selection. Share links carry it
 * as token 0u.
 */
export function createSeaWeatherLayer({
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
    throw new TypeError('Sea weather requires a snapshot source');
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
  let _stations = [];
  let _values = true;
  const _stationById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(SEA_WEATHER_LAYER_ID);
  // A level counts only against mean water: other zeros share no scale.
  const shownValue = (row) => meanWaterLevel(row);

  /** A station's dot as the set draws it. */
  const dotOf = (row) => {
    const has = Number.isFinite(shownValue(row));
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row),
      height: 'clampGround',
      pixelSize: has ? 10 : 6,
      color: has ? seaColor(row) : withAlpha(NO_VALUE_COLOR, 0.6),
      outlineColor: OUTLINE_COLOR,
      outlineWidth: 2,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        SEA_WEATHER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildSeaCard(row, { nowMs: now() });
    card.position = placeOf(row);
    overlayHost.setEntries(
      SEA_WEATHER_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStation(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stationById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      SEA_WEATHER_LAYER_ID,
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
      const hit = pickedStation(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SEA_WEATHER_LAYER_ID, pickId))
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
    picking?.unregisterPickOwner?.(SEA_WEATHER_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    for (const id of [SEA_WEATHER_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _values) {
      for (const row of _stations) {
        const value = shownValue(row);
        if (!Number.isFinite(value)) continue;
        entries.push({
          id: `sea-weather-label:${row.id}`,
          position: placeOf(row),
          variant: 'label',
          title: `${formatNumber(value, { signDisplay: 'exceptZero' })} cm`,
          accent: seaColor(row),
          // The furthest from mean water win the label budget.
          priority: Math.round(Math.abs(value) * 100),
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
      .map((id) => _stationById.get(id))
      .filter(Boolean);
    if (rows.length) _dots.upsert(rows.map(dotOf));
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    _dots.set(_stations.map(dotOf));
    _drawn = new Set(_stations.map((row) => row.id));
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: SEA_WEATHER_LAYER_ID,
    name: 'Sea Weather (Sweden)',
    icon: '🌊',
    source: 'SMHI',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('Sea weather layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: SEA_WEATHER_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(SEA_WEATHER_OVERLAY_SOURCE_ID, true);
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
        // What a dot and its label look like; the time alone redraws nothing.
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [
            row.id,
            row.level,
            row.levelReference,
          ]),
        );
        // The newest rows always: the card reads them, drawn again or not.
        _stations = snapshot.stations;
        _stationById.clear();
        for (const row of _stations) _stationById.set(row.id, row);
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_stations);
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          try {
            render();
          } catch (e) {
            console.warn('[Data:SeaWeather] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Sea weather unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(
            `[Data:SeaWeather] Updated: ${_stations.length} stations`,
          );
        } else if (_selectedId) publishSelectedCard();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SeaWeather] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Sea weather unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _ground.clear();
      _stationById.clear();
      _stations = [];
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
      const legend = LEVEL_CLASSES.map(({ id, color }) => ({
        label: t(LEVEL_LABELS[id]),
        color,
        count: _stations.filter(
          (row) => classOf(LEVEL_CLASSES, shownValue(row))?.id === id,
        ).length,
      })).filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'values',
            label: t('VALUES'),
            active: _values,
            title: t('Write the value beside the stations that stand out most'),
            onClick: () => {
              _values = !_values;
              publishLabels();
              _rowListener?.();
            },
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are SMHI’s ocean stations along the coast. Grey dots do not measure what is shown. Click a station for water level, water temperature and waves.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: _stations.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
