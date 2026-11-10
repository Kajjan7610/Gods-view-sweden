import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  WIND_CLASSES,
  classOf,
} from './records.js';
import {
  SEA_WEATHER_OVERLAY_SOURCE_ID,
  buildSeaCard,
  seaColor,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSeaWeatherSource } from './source.js';

const PICK_PREFIX = 'se-viva:';
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
const WIND_LABELS = Object.freeze({
  calm: msg('Up to 4 m/s'),
  moderate: msg('4 to 8 m/s'),
  fresh: msg('8 to 13 m/s'),
  gale: msg('13 to 20 m/s (gale)'),
  storm: msg('Above 20 m/s (storm)'),
});
const LEVEL_LABELS = Object.freeze({
  'very-low': msg('40 cm or more below mean'),
  low: msg('10 to 40 cm below mean'),
  normal: msg('Within 10 cm of mean'),
  high: msg('10 to 40 cm above mean'),
  'very-high': msg('40 cm or more above mean'),
});
const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Own one Swedish sea weather display: Sjöfartsverket's ViVa stations
 * coloured by mean wind (or water level against mean water), with the value
 * written beside the windiest (or furthest-off) stations and click-to-card
 * selection. Share links carry it as token 0u.
 */
export function createSeaWeatherLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Sea weather requires a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) =>
    Cesium.Cartesian3.fromDegrees(
      row.point[0],
      row.point[1],
      _ground.heightOf(row.id),
    );
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
  /** 'wind' or 'level'. */
  let _mode = 'wind';
  let _values = true;
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const shownValue = (row) => (_mode === 'level' ? row.level : row.meanWind);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        SEA_WEATHER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildSeaCard(row, { mode: _mode });
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SEA_WEATHER_OVERLAY_SOURCE_ID,
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
        { sourceId: SEA_WEATHER_OVERLAY_SOURCE_ID },
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

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
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
          position: position(row),
          variant: 'label',
          title:
            _mode === 'level'
              ? `${formatNumber(value, { signDisplay: 'exceptZero' })} cm`
              : `${oneDecimal(value)} m/s`,
          accent: seaColor(row, _mode),
          // The windiest, or furthest from mean water, win the label budget.
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
    if (!_dataSource) return;
    liftEntities(
      _dataSource.entities,
      ids,
      (id) => `${PICK_PREFIX}${id}`,
      (id) => {
        const row = _stationById.get(id);
        return row && position(row);
      },
    );
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    redrawEntities(entities, () => {
      for (const row of _stations) {
        const has = Number.isFinite(shownValue(row));
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: has ? 10 : 6,
            color: Cesium.Color.fromCssColorString(
              has ? seaColor(row, _mode) : NO_VALUE_COLOR,
            ).withAlpha(has ? 1 : 0.6),
            outlineColor: Cesium.Color.fromCssColorString('#0d47a1'),
            outlineWidth: 2,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    });
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
    id: 'sea-weather',
    name: 'Sea Weather (Sweden)',
    icon: '🌊',
    source: 'Sjöfartsverket',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('Sea weather layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sea-weather');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SEA_WEATHER_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
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
          snapshot.stations.map((row) => [row.id, row.updated, row.meanWind]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          // Heights first: the ones this browser kept are drawn at once.
          _ground.place(_stations);
          render();
          console.log(
            `[Data:SeaWeather] Updated: ${_stations.length} stations`,
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
        console.warn('[Data:SeaWeather] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Sea weather unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _ground.clear();
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
      const classes = _mode === 'level' ? LEVEL_CLASSES : WIND_CLASSES;
      const labels = _mode === 'level' ? LEVEL_LABELS : WIND_LABELS;
      const legend = classes
        .map(({ id, color }) => ({
          label: t(labels[id]),
          color,
          count: _stations.filter(
            (row) => classOf(classes, shownValue(row))?.id === id,
          ).length,
        }))
        .filter((item) => item.count > 0);
      return {
        chips: [
          {
            id: 'wind',
            label: t('WIND'),
            active: _mode === 'wind',
            title: t('Colour stations by mean wind'),
            onClick: () => setMode('wind'),
          },
          {
            id: 'level',
            label: t('WATER LEVEL'),
            active: _mode === 'level',
            title: t('Colour stations by water level against mean water'),
            onClick: () => setMode('level'),
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
                  'Dots are Sjöfartsverket’s ViVa stations along the coast, lakes and canals. Grey dots do not measure what is shown. Click a station for wind, water level, temperatures and waves.',
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
