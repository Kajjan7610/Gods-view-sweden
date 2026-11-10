import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
import { READINESS_CLASSES, UNKNOWN_COLOR, readinessColor } from './records.js';
import {
  FIRE_STATIONS_OVERLAY_SOURCE_ID,
  buildFireStationCard,
  readinessLabel,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createFireStationsSource } from './source.js';

const PICK_PREFIX = 'se-fire-station:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Dot size by readiness: staffed around the clock reads largest. */
const PIXEL_SIZE = Object.freeze({
  'full-time': 11,
  'retained-officer': 9,
  retained: 8,
  'rescue-post': 7,
});

/**
 * Own one Swedish fire station display: MCF's register of the municipal
 * rescue services' stations, coloured by their highest form of readiness,
 * with click-to-card selection. Share links carry it as token 0m.
 */
export function createFireStationsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fire stations require a snapshot source');
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
  const _stationById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        FIRE_STATIONS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildFireStationCard(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      FIRE_STATIONS_OVERLAY_SOURCE_ID,
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
        { sourceId: FIRE_STATIONS_OVERLAY_SOURCE_ID },
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
    overlayHost.clearSource(FIRE_STATIONS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(FIRE_STATIONS_OVERLAY_SOURCE_ID, false);
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
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    redrawEntities(entities, () => {
      // Weakest first, so full-time stations draw on top where dots meet.
      for (const row of [..._stations].reverse()) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: PIXEL_SIZE[row.readiness] ?? 7,
            color: Cesium.Color.fromCssColorString(
              readinessColor(row.readiness),
            ),
            outlineColor: Cesium.Color.fromCssColorString('#2b0b0b'),
            outlineWidth: 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.2, 2e6, 0.7),
          },
        });
      }
    });
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'fire-stations',
    name: 'Fire Stations (Sweden)',
    icon: '🚒',
    source: 'MCF',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Fire stations layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('fire-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(FIRE_STATIONS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
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
          snapshot.stations.map((row) => [row.id, row.readiness, row.point]),
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
            `[Data:FireStations] Updated: ${_stations.length} stations`,
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
        console.warn('[Data:FireStations] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Fire station data unavailable');
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
      const legend = READINESS_CLASSES.map((entry) => ({
        label: readinessLabel(entry.id),
        color: entry.color,
        count: _stations.filter((row) => row.readiness === entry.id).length,
      }));
      legend.push({
        label: readinessLabel(null),
        color: UNKNOWN_COLOR,
        count: _stations.filter((row) => !row.readiness).length,
      });
      return {
        legend: legend
          .filter((item) => item.count > 0)
          .map((item, index) =>
            index === 0
              ? {
                  ...item,
                  blurb: t(
                    'Dots are the municipal rescue services’ fire stations as MCF registers them, coloured by each station’s highest readiness: full-time crews on duty around the clock, retained crews called in from home or work, some with a first-response officer, and smaller municipal rescue posts. Positions vary in accuracy. Click a station for details.',
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
