import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  ICE_RISK_COLOR,
  NO_READING_COLOR,
  TEMPERATURE_CLASSES,
  temperatureClass,
  temperatureColor,
} from './records.js';
import {
  ROAD_WEATHER_OVERLAY_SOURCE_ID,
  buildStationCard,
  formatCelsius,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createTrafikverketWeatherSource } from './source.js';

export const ROAD_WEATHER_LAYER_ID = 'trafikverket-weather';
const PICK_PREFIX = 'se-roadwx:';
const OUTLINE_COLOR = 'rgba(0, 0, 0, 0.75)';
/** A palette colour at `alpha`, as the renderer takes it. */
const withAlpha = (css, alpha) => {
  const [r, g, b] = cssColor(css);
  return [r, g, b, alpha];
};
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const CLASS_LABELS = Object.freeze({
  'below-10': msg('−10 °C and colder'),
  'minus-10-5': msg('−10 to −5 °C'),
  'minus-5-0': msg('−5 to 0 °C'),
  'zero-3': msg('0 to +3 °C'),
  'three-8': msg('+3 to +8 °C'),
  'above-8': msg('Above +8 °C'),
});
/** Temperature labels: every station competes; the overlay paints what fits. */
const LABEL_SOURCE_ID = 'trafikverket-weather-labels';
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 900,
  collisionCapacity: 48,
  moving: false,
});
/** A station whose sample is older than this is drawn faded. */
const FADE_AFTER_MS = 60 * 60_000;

/**
 * Own one Swedish road weather display: Trafikverket's road weather stations
 * coloured by road-surface (or air) temperature, a white ring where the road
 * risks ice, with click-to-card selection. Share links carry it as token 0z.
 */
export function createTrafikverketWeatherLayer({
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
    throw new TypeError('Trafikverket road weather requires a snapshot source');
  const faded = (row, at) => at - row.sampled > FADE_AFTER_MS;
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
  /** The clock of the last drawing: a dot moved by a height keeps its fade. */
  let _drawnAt = 0;
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
  /** 'surface' or 'air': which temperature colours the dots. */
  let _mode = 'surface';
  const _show = { values: true, riskOnly: false };
  const _stationById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(ROAD_WEATHER_LAYER_ID);
  const shownValue = (row) => (_mode === 'air' ? row.airTemp : row.surfaceTemp);
  const visibleStations = () =>
    _show.riskOnly ? _stations.filter((row) => row.risk) : _stations;

  /** A station's dot as the set draws it, faded by the clock at `at`. */
  const dotOf = (row, at) => {
    const color = temperatureColor(shownValue(row));
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row),
      height: 'clampGround',
      pixelSize: row.risk ? 11 : 9,
      color: faded(row, at) ? withAlpha(color, 0.45) : color,
      outlineColor: row.risk ? ICE_RISK_COLOR : OUTLINE_COLOR,
      outlineWidth: row.risk ? 3 : 1.5,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        ROAD_WEATHER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStationCard(row, { mode: _mode });
    card.position = placeOf(row);
    overlayHost.setEntries(
      ROAD_WEATHER_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a pick id to a station id of this layer, or null. */
  function pickedStation(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stationById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      ROAD_WEATHER_LAYER_ID,
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
      if (pickId && picking.isOwnedByOtherLayer(ROAD_WEATHER_LAYER_ID, pickId))
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
    picking?.unregisterPickOwner?.(ROAD_WEATHER_LAYER_ID);
  }

  function clearSelection() {
    _selectedId = null;
    if (overlayHost) {
      overlayHost.clearSource(ROAD_WEATHER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(ROAD_WEATHER_OVERLAY_SOURCE_ID, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _show.values) {
      for (const row of visibleStations()) {
        const value = shownValue(row);
        if (!Number.isFinite(value)) continue;
        entries.push({
          id: `trafikverket-weather-label:${row.id}`,
          position: placeOf(row),
          variant: 'label',
          title: formatCelsius(value),
          accent: temperatureColor(value),
          // Risk of ice first, then the coldest roads, win the label budget.
          priority: (row.risk ? 1_000_000 : 0) + Math.round((60 - value) * 100),
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
    if (rows.length) _dots.upsert(rows.map((row) => dotOf(row, _drawnAt)));
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    const at = now();
    const rows = visibleStations();
    _dots.set(rows.map((row) => dotOf(row, at)));
    _drawn = new Set(rows.map((row) => row.id));
    _drawnAt = at;
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  function setMode(mode) {
    if (_mode === mode) return;
    _mode = mode;
    render();
    _rowListener?.();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: ROAD_WEATHER_LAYER_ID,
    name: 'Road Weather (Sweden)',
    icon: '🌡️',
    source: 'Trafikverket',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error(
          'Trafikverket road weather layer is already initialized',
        );
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: ROAD_WEATHER_LAYER_ID,
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
      overlayHost?.setVisible?.(ROAD_WEATHER_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      // Stations already loaded (re-enable) get their labels back at once.
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
      clearSelection();
      if (overlayHost) {
        overlayHost.clearSource(LABEL_SOURCE_ID);
        overlayHost.setVisible?.(LABEL_SOURCE_ID, false);
      }
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
        const at = now();
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : at;
        _lastError = null;
        // Fading is part of what is drawn: a station passes the hour while
        // the data stands still, as it does through an outage.
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [
            row.id,
            row.sampled,
            row.surfaceTemp,
            row.airTemp,
            row.risk,
            faded(row, at),
          ]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_stations);
          try {
            render();
          } catch (e) {
            console.warn(
              '[Data:TrafikverketWeather] Draw error:',
              e?.message || e,
            );
            _lastError = e?.message || msg('Trafikverket feed unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(
            `[Data:TrafikverketWeather] Updated: ${_stations.length} stations, ${
              _stations.filter((row) => row.risk).length
            } with risk of ice`,
          );
        } else {
          if (_selectedId) publishSelectedCard();
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_stations);
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(
          '[Data:TrafikverketWeather] Fetch error:',
          e?.message || e,
        );
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
      const shown = visibleStations();
      const counts = new Map();
      let noReading = 0;
      for (const row of shown) {
        const entry = temperatureClass(shownValue(row));
        if (entry) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
        else noReading++;
      }
      const legend = TEMPERATURE_CLASSES.map(({ id, color }) => ({
        label: t(CLASS_LABELS[id]),
        color,
        count: counts.get(id) || 0,
      })).filter((item) => item.count > 0);
      if (noReading)
        legend.push({
          label: t('No reading'),
          color: NO_READING_COLOR,
          count: noReading,
        });
      legend.push({
        label: t('Risk of ice (white ring)'),
        color: ICE_RISK_COLOR,
        count: _stations.filter((row) => row.risk).length,
      });
      return {
        chips: [
          {
            id: 'surface',
            label: t('ROAD SURFACE'),
            active: _mode === 'surface',
            title: t('Colour stations by road-surface temperature'),
            onClick: () => setMode('surface'),
          },
          {
            id: 'air',
            label: t('AIR'),
            active: _mode === 'air',
            title: t('Colour stations by air temperature'),
            onClick: () => setMode('air'),
          },
          {
            id: 'values',
            label: t('VALUES'),
            active: _show.values,
            title: t(
              'Write the temperature beside each station when zoomed in',
            ),
            onClick: () => toggle('values'),
          },
          {
            id: 'risk',
            label: t('ICE RISK ONLY'),
            active: _show.riskOnly,
            title: t(
              'Show only stations where frost, precipitation on a frozen road, or measured ice makes the road slippery',
            ),
            onClick: () => toggle('riskOnly'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are Trafikverket road weather stations coloured by temperature; a white ring marks a risk of ice. Click a station for its readings.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: visibleStations().length,
        stations: _stations.length,
        iceRisk: _stations.filter((row) => row.risk).length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
