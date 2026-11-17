import { formatNumber, msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  NO_READING_COLOR,
  TEMPERATURE_CLASSES,
  temperatureClass,
  temperatureColor,
} from '../roadWeather/records.js';
import { formatCelsius } from '../roadWeather/cards.js';
import { WIND_CLASSES, classOf } from '../seaWeather/records.js';
import { SMHI_WEATHER_OVERLAY_SOURCE_ID, buildWeatherCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSmhiWeatherSource } from './source.js';

export const SMHI_WEATHER_LAYER_ID = 'smhi-weather';
const PICK_PREFIX = 'se-smhiobs:';
const OUTLINE_COLOR = 'rgba(255, 255, 255, 0.9)';
/** A palette colour at `alpha`, as the renderer takes it. */
const withAlpha = (css, alpha) => {
  const [r, g, b] = cssColor(css);
  return [r, g, b, alpha];
};
const LABEL_SOURCE_ID = 'smhi-weather-labels';
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
const TEMPERATURE_LABELS = Object.freeze({
  'below-10': msg('−10 °C and colder'),
  'minus-10-5': msg('−10 to −5 °C'),
  'minus-5-0': msg('−5 to 0 °C'),
  'zero-3': msg('0 to +3 °C'),
  'three-8': msg('+3 to +8 °C'),
  'above-8': msg('Above +8 °C'),
});
const WIND_LABELS = Object.freeze({
  calm: msg('Up to 4 m/s'),
  moderate: msg('4 to 8 m/s'),
  fresh: msg('8 to 13 m/s'),
  gale: msg('13 to 20 m/s (gale)'),
  storm: msg('Above 20 m/s (storm)'),
});
/** A station's forecast is fetched again after this long. */
const FORECAST_REUSE_MS = 30 * 60_000;
const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Own one Swedish weather-now display: SMHI's observing stations coloured by
 * air temperature (or mean wind), with the value beside the stations that
 * stand out, and a card that adds SMHI's forecast for the spot. Share links
 * carry it as token 0s.
 */
export function createSmhiWeatherLayer({
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
    throw new TypeError('SMHI weather requires a snapshot source');
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
  /** 'temperature' or 'wind'. */
  let _mode = 'temperature';
  /** station id → {state, forecast, at} */
  const _forecasts = new Map();
  let _values = true;
  const _stationById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(SMHI_WEATHER_LAYER_ID);
  const shownValue = (row) => (_mode === 'wind' ? row.wind : row.airTemp);
  const colorOf = (row) =>
    _mode === 'wind'
      ? classOf(WIND_CLASSES, row.wind)?.color || NO_READING_COLOR
      : temperatureColor(row.airTemp);

  /** A station's dot as the set draws it. */
  const dotOf = (row) => {
    const has = Number.isFinite(shownValue(row));
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row),
      height: 'clampGround',
      pixelSize: has ? 10 : 6,
      color: has ? colorOf(row) : withAlpha(NO_READING_COLOR, 0.6),
      outlineColor: OUTLINE_COLOR,
      outlineWidth: 1.5,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
  };

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        SMHI_WEATHER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const entry = _forecasts.get(row.id);
    const card = buildWeatherCard(row, {
      forecast: entry?.forecast ?? null,
      forecastState: entry?.state ?? 'loading',
    });
    card.position = placeOf(row);
    overlayHost.setEntries(
      SMHI_WEATHER_OVERLAY_SOURCE_ID,
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
      SMHI_WEATHER_LAYER_ID,
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
        loadForecast(hit);
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SMHI_WEATHER_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
      }
    });
  }

  /** Fetch the selected station's forecast once per half hour, then re-card. */
  async function loadForecast(id) {
    const row = _stationById.get(id);
    const known = _forecasts.get(id);
    if (!row || typeof source.getForecast !== 'function') return;
    if (
      known &&
      (known.state === 'loading' || now() - known.at < FORECAST_REUSE_MS)
    )
      return;
    _forecasts.set(id, { state: 'loading', forecast: null, at: now() });
    publishSelectedCard();
    try {
      const forecast = await source.getForecast({
        lat: row.point[1],
        lon: row.point[0],
      });
      _forecasts.set(id, { state: 'ready', forecast, at: now() });
    } catch (e) {
      console.warn('[Data:SmhiWeather] Forecast error:', e?.message || e);
      _forecasts.set(id, { state: 'failed', forecast: null, at: 0 });
    }
    if (_selectedId === id) publishSelectedCard();
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(SMHI_WEATHER_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    for (const id of [SMHI_WEATHER_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
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
          id: `smhi-weather-label:${row.id}`,
          position: placeOf(row),
          variant: 'label',
          title:
            _mode === 'wind'
              ? `${oneDecimal(value)} m/s`
              : formatCelsius(value),
          accent: colorOf(row),
          // The coldest (or windiest) stations win the label budget.
          priority: Math.round((_mode === 'wind' ? value : 60 - value) * 100),
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

  function setMode(mode) {
    if (_mode === mode) return;
    _mode = mode;
    render();
    _rowListener?.();
  }

  const layer = {
    id: SMHI_WEATHER_LAYER_ID,
    name: 'Weather Now (Sweden)',
    icon: '🌡',
    source: 'SMHI',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('SMHI weather layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: SMHI_WEATHER_LAYER_ID,
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
      overlayHost?.setVisible?.(SMHI_WEATHER_OVERLAY_SOURCE_ID, true);
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
        // Every reading counts: wind, gusts or rain can come back within the
        // hour while the temperature and its time stay the same.
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [
            row.id,
            row.updated,
            row.airTemp,
            row.wind,
            row.gust,
            row.precipitation,
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
            console.warn('[Data:SmhiWeather] Draw error:', e?.message || e);
            _lastError = e?.message || msg('SMHI weather unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(
            `[Data:SmhiWeather] Updated: ${_stations.length} stations`,
          );
        } else {
          // Takes up again what a switched-off layer had left to ask.
          _ground.place(_stations);
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SmhiWeather] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('SMHI weather unavailable');
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
      _forecasts.clear();
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
      const classes = _mode === 'wind' ? WIND_CLASSES : TEMPERATURE_CLASSES;
      const labels = _mode === 'wind' ? WIND_LABELS : TEMPERATURE_LABELS;
      const classify = (row) =>
        _mode === 'wind'
          ? classOf(WIND_CLASSES, row.wind)
          : temperatureClass(row.airTemp);
      const legend = classes
        .map(({ id, color }) => ({
          label: t(labels[id]),
          color,
          count: _stations.filter((row) => classify(row)?.id === id).length,
        }))
        .filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'temperature',
            label: t('TEMPERATURE'),
            active: _mode === 'temperature',
            title: t('Colour stations by air temperature'),
            onClick: () => setMode('temperature'),
          },
          {
            id: 'wind',
            label: t('WIND'),
            active: _mode === 'wind',
            title: t('Colour stations by mean wind'),
            onClick: () => setMode('wind'),
          },
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
                  'Dots are SMHI’s weather stations with their latest hourly reading. Click a station for the reading and SMHI’s forecast for the spot.',
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
