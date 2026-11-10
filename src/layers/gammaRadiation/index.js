import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
import {
  DOSE_CLASSES,
  SERVICE_COLOR,
  doseClass,
  doseColor,
} from './records.js';
import {
  GAMMA_RADIATION_OVERLAY_SOURCE_ID,
  buildGammaCard,
  formatDose,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createGammaRadiationSource } from './source.js';

const PICK_PREFIX = 'se-gamma:';
const LABEL_SOURCE_ID = 'gamma-radiation-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 100,
  collisionCapacity: 40,
  moving: false,
});

/** The legend row for one dose class. */
function classLabel(entry) {
  return Number.isFinite(entry.max)
    ? t('{from}–{to} µSv/h', {
        from: formatDose(entry.min),
        to: formatDose(entry.max),
      })
    : t('Above {value} µSv/h', { value: formatDose(entry.min) });
}

/**
 * Own one Swedish radiation display: Strålsäkerhetsmyndigheten's gamma
 * stations coloured by the latest hourly ambient dose rate on SSM's own
 * scale, with the value beside each and click-to-card selection. Share links
 * carry it as token 0p.
 */
export function createGammaRadiationLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Gamma radiation requires a snapshot source');
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
  let _stations = [];
  let _values = true;
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        GAMMA_RADIATION_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildGammaCard(row);
    card.position = position(row);
    overlayHost.setEntries(
      GAMMA_RADIATION_OVERLAY_SOURCE_ID,
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
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(click.position?.x, click.position?.y)) return;
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
    if (!overlayHost) return;
    for (const id of [GAMMA_RADIATION_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled && _values) {
      for (const row of _stations) {
        if (row.value == null) continue;
        entries.push({
          id: `gamma-radiation-label:${row.id}`,
          position: position(row),
          variant: 'label',
          title: `${formatDose(row.value)} µSv/h`, // i18n-ignore: unit
          accent: doseColor(row.value),
          // The highest readings win the label budget.
          priority: Math.round(row.value * 10000),
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
        const has = row.value != null;
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: has ? 12 : 7,
            color: Cesium.Color.fromCssColorString(
              doseColor(row.value),
            ).withAlpha(has ? 1 : 0.7),
            outlineColor: Cesium.Color.fromCssColorString('#ffd600'),
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

  const layer = {
    id: 'gamma-radiation',
    name: 'Radiation (Sweden)',
    icon: '☢️',
    source: 'Strålsäkerhetsmyndigheten',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer)
        throw new Error('Gamma radiation layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gamma-radiation');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(GAMMA_RADIATION_OVERLAY_SOURCE_ID, true);
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
          snapshot.stations.map((row) => [row.id, row.updated, row.value]),
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
            `[Data:GammaRadiation] Updated: ${_stations.length} stations`,
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
        console.warn('[Data:GammaRadiation] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Radiation data unavailable');
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
      const legend = DOSE_CLASSES.map((entry) => ({
        label: classLabel(entry),
        color: entry.color,
        count: _stations.filter((row) => doseClass(row.value) === entry).length,
      }));
      legend.push({
        label: t('Station in service or maintenance'),
        color: SERVICE_COLOR,
        count: _stations.filter((row) => row.value == null).length,
      });
      return {
        chips: [
          {
            id: 'values',
            label: t('VALUES'),
            active: _values,
            title: t('Write the dose rate beside each station'),
            onClick: () => {
              _values = !_values;
              publishLabels();
              _rowListener?.();
            },
          },
        ],
        legend: legend
          .filter((item) => item.count > 0)
          .map((item, index) =>
            index === 0
              ? {
                  ...item,
                  blurb: t(
                    'Dots are Strålsäkerhetsmyndigheten’s gamma stations, the national early-warning network, with the latest hourly dose rate in microsievert per hour. The natural background in Sweden is normally 0.05–0.3 µSv/h. Click a station for its reading.',
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
