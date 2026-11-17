import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
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

export const POLICE_STATIONS_LAYER_ID = 'police-stations';
const PICK_PREFIX = 'se-police-station:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Dot size by desk: a passport desk reads largest. */
const PIXEL_SIZE = Object.freeze({ passport: 10, desk: 8, 'no-desk': 7 });
const OUTLINE_COLOR = '#0b1a2b';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 2e4,
  nearValue: 1.2,
  far: 2e6,
  farValue: 0.7,
});

/**
 * Own one Swedish police station display: Polismyndigheten's list of its
 * stations, coloured by what their public desk offers, with click-to-card
 * selection; a click on the card opens the station's page on polisen.se.
 * Share links carry it as token 0i.
 */
export function createPoliceStationsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Police stations require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  let _viewer = null;
  let _dots = null;
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

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(POLICE_STATIONS_LAYER_ID);

  /** A station's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: PIXEL_SIZE[deskClass(row)],
    color: deskColor(row),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

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
    if (card.accessibilityLabel) card.activate = () => openPage(row);
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      POLICE_STATIONS_OVERLAY_SOURCE_ID,
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
      POLICE_STATIONS_LAYER_ID,
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
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y);
      if (
        cardHit?.sourceId === POLICE_STATIONS_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      )
        openPage(_stationById.get(_selectedId));
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedStation(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(POLICE_STATIONS_LAYER_ID, pickId)
      )
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
    picking?.unregisterPickOwner?.(POLICE_STATIONS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(POLICE_STATIONS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(POLICE_STATIONS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids.map((id) => _stationById.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Desks without services first, so passport desks draw on top.
    _dots.set([..._stations].reverse().map(dotOf));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: POLICE_STATIONS_LAYER_ID,
    name: 'Police Stations (Sweden)',
    icon: '👮',
    source: 'Polisen',
    updateInterval: 6 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Police stations layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: POLICE_STATIONS_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(POLICE_STATIONS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
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
            : Date.now();
        _lastError = null;
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [
            row.id,
            row.point,
            row.services,
            row.name,
            row.address,
            row.url,
          ]),
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
            `[Data:PoliceStations] Updated: ${_stations.length} stations`,
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
        console.warn('[Data:PoliceStations] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Police station data unavailable');
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
