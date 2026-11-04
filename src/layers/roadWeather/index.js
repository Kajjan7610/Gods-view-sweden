import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
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

const PICK_PREFIX = 'se-roadwx:';
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
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Trafikverket road weather requires a snapshot source');
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
  /** 'surface' or 'air': which temperature colours the dots. */
  let _mode = 'surface';
  const _show = { values: true, riskOnly: false };
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const shownValue = (row) => (_mode === 'air' ? row.airTemp : row.surfaceTemp);
  const visibleStations = () =>
    _show.riskOnly ? _stations.filter((row) => row.risk) : _stations;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        ROAD_WEATHER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStationCard(row, { mode: _mode });
    card.position = Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1]);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      ROAD_WEATHER_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to a station id of this layer, or null. */
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
        { sourceId: ROAD_WEATHER_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStation(picked) : null;
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
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

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
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
          position: Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1]),
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

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const now = Date.now();
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of visibleStations()) {
        const faded = now - row.sampled > FADE_AFTER_MS;
        const color = Cesium.Color.fromCssColorString(
          temperatureColor(shownValue(row)),
        ).withAlpha(faded ? 0.45 : 1);
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1]),
          point: {
            pixelSize: row.risk ? 11 : 9,
            color,
            outlineColor: row.risk
              ? Cesium.Color.fromCssColorString(ICE_RISK_COLOR)
              : Cesium.Color.BLACK.withAlpha(0.75),
            outlineWidth: row.risk ? 3 : 1.5,
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

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: 'trafikverket-weather',
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
      _dataSource = new Cesium.CustomDataSource('trafikverket-weather');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(ROAD_WEATHER_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      // Stations already loaded (re-enable) get their labels back at once.
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
      if (overlayHost) {
        overlayHost.clearSource(LABEL_SOURCE_ID);
        overlayHost.setVisible?.(LABEL_SOURCE_ID, false);
      }
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
          snapshot.stations.map((row) => [
            row.id,
            row.sampled,
            row.surfaceTemp,
            row.airTemp,
            row.risk,
          ]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          render();
          console.log(
            `[Data:TrafikverketWeather] Updated: ${_stations.length} stations, ${
              _stations.filter((row) => row.risk).length
            } with risk of ice`,
          );
        } else if (_selectedId) publishSelectedCard();
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

    destroy(viewer = _viewer) {
      layer.disable();
      _stationById.clear();
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
