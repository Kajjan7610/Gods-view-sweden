import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
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

const PICK_PREFIX = 'se-smhiobs:';
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
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SMHI weather requires a snapshot source');
  let _viewer = null;
  let _dataSource = null;
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
  let _stations = [];
  /** 'temperature' or 'wind'. */
  let _mode = 'temperature';
  /** station id → {state, forecast, at} */
  const _forecasts = new Map();
  let _values = true;
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const shownValue = (row) => (_mode === 'wind' ? row.wind : row.airTemp);
  const colorOf = (row) =>
    _mode === 'wind'
      ? classOf(WIND_CLASSES, row.wind)?.color || NO_READING_COLOR
      : temperatureColor(row.airTemp);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
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
    card.position = Cesium.Cartesian3.fromDegrees(...row.point);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SMHI_WEATHER_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStation(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _stationById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SMHI_WEATHER_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStation(picked) : null;
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        loadForecast(hit);
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Fetch the selected station's forecast once per half hour, then re-card. */
  async function loadForecast(id) {
    const row = _stationById.get(id);
    const known = _forecasts.get(id);
    if (!row || typeof source.getForecast !== 'function') return;
    if (
      known &&
      (known.state === 'loading' || Date.now() - known.at < FORECAST_REUSE_MS)
    )
      return;
    _forecasts.set(id, { state: 'loading', forecast: null, at: Date.now() });
    publishSelectedCard();
    try {
      const forecast = await source.getForecast({
        lat: row.point[1],
        lon: row.point[0],
      });
      _forecasts.set(id, { state: 'ready', forecast, at: Date.now() });
    } catch (e) {
      console.warn('[Data:SmhiWeather] Forecast error:', e?.message || e);
      _forecasts.set(id, { state: 'failed', forecast: null, at: 0 });
    }
    if (_selectedId === id) publishSelectedCard();
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
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
          position: Cesium.Cartesian3.fromDegrees(...row.point),
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

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of _stations) {
        const has = Number.isFinite(shownValue(row));
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: Cesium.Cartesian3.fromDegrees(...row.point),
          point: {
            pixelSize: has ? 10 : 6,
            color: Cesium.Color.fromCssColorString(
              has ? colorOf(row) : NO_READING_COLOR,
            ).withAlpha(has ? 1 : 0.6),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    publishLabels();
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function setMode(mode) {
    if (_mode === mode) return;
    _mode = mode;
    render();
    _rowListener?.();
  }

  const layer = {
    id: 'smhi-weather',
    name: 'Weather Now (Sweden)',
    icon: '🌡',
    source: 'SMHI',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('SMHI weather layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('smhi-weather');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SMHI_WEATHER_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
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
            : Date.now();
        _lastError = null;
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [row.id, row.updated, row.airTemp]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          render();
          console.log(
            `[Data:SmhiWeather] Updated: ${_stations.length} stations`,
          );
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

    destroy(viewer = _viewer) {
      layer.disable();
      _stationById.clear();
      _forecasts.clear();
      _stations = [];
      _signature = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
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
