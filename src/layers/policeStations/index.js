import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { DESK_CLASSES, deskClass, deskColor } from './records.js';
import {
  POLICE_STATIONS_OVERLAY_SOURCE_ID,
  buildPoliceStationCard,
  deskLabel,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createPoliceStationsSource } from './source.js';

const PICK_PREFIX = 'se-police-station:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Dot size by desk: a passport desk reads largest. */
const PIXEL_SIZE = Object.freeze({ passport: 10, desk: 8, 'no-desk': 7 });

/**
 * Own one Swedish police station display: Polismyndigheten's list of its
 * stations, coloured by what their public desk offers, with click-to-card
 * selection; a click on the card opens the station's page on polisen.se.
 * Share links carry it as token 0i.
 */
export function createPoliceStationsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Police stations require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, () => render());
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

  function openPage(row) {
    if (!row?.url || !openExternal) return false;
    openExternal(row.url);
    return true;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _stationById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        POLICE_STATIONS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildPoliceStationCard(row, {
      stations: _stations,
      linkable: Boolean(openExternal),
    });
    if (card.interactive) card.activate = () => openPage(row);
    card.position = position(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      POLICE_STATIONS_OVERLAY_SOURCE_ID,
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
        { sourceId: POLICE_STATIONS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        openPage(_stationById.get(_selectedId));
        return;
      }
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
    overlayHost.clearSource(POLICE_STATIONS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(POLICE_STATIONS_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      // Desks without services first, so passport desks draw on top.
      for (const row of [..._stations].reverse()) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: PIXEL_SIZE[deskClass(row)],
            color: Cesium.Color.fromCssColorString(deskColor(row)),
            outlineColor: Cesium.Color.fromCssColorString('#0b1a2b'),
            outlineWidth: 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.2, 2e6, 0.7),
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'police-stations',
    name: 'Police Stations (Sweden)',
    icon: '👮',
    source: 'Polisen',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Police stations layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('police-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(POLICE_STATIONS_OVERLAY_SOURCE_ID, true);
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
          snapshot.stations.map((row) => [row.id, row.point, row.services]),
        );
        if (signature !== _signature) {
          _signature = signature;
          _stations = snapshot.stations;
          _stationById.clear();
          for (const row of _stations) _stationById.set(row.id, row);
          render();
          console.log(
            `[Data:PoliceStations] Updated: ${_stations.length} stations`,
          );
        }
        _ground.place(_stations);
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:PoliceStations] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Police station data unavailable');
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
      const legend = DESK_CLASSES.map((entry) => ({
        label: deskLabel(entry.id),
        color: entry.color,
        count: _stations.filter((row) => deskClass(row) === entry.id).length,
      }));
      return {
        legend: legend
          .filter((item) => item.count > 0)
          .map((item, index) =>
            index === 0
              ? {
                  ...item,
                  blurb: t(
                    'Dots are the police stations Polisen lists, coloured by what their public desk offers: passports and ID cards, other errands such as reporting a crime or handing in found property, or no desk services listed. Opening hours vary and change; click a station, then its card, for its page on polisen.se.',
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
