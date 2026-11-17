import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
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

export const GAMMA_RADIATION_LAYER_ID = 'gamma-radiation';
const PICK_PREFIX = 'se-gamma:';
const LABEL_SOURCE_ID = 'gamma-radiation-labels';
const OUTLINE_COLOR = '#ffd600';
/** A station in service or maintenance: its dot a little see-through. */
const SILENT_ALPHA = 0.7;

/** `#rrggbb` at `alpha`, as a CSS colour. */
function withAlpha(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
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
  picking = null,
  pointer = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Gamma radiation requires a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  /** Where a card or label on the station sits, in ECEF. */
  const anchorOf = (row) => {
    const at = position(row);
    return fromDegrees(at.lon, at.lat, at.height);
  };
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
  let _stations = [];
  let _values = true;
  const _stationById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(GAMMA_RADIATION_LAYER_ID);

  /** A station's dot as the set draws it. */
  const dotOf = (row) => {
    const has = row.value != null;
    const color = doseColor(row.value);
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row),
      height: 'clampGround',
      pixelSize: has ? 12 : 7,
      color: has ? color : withAlpha(color, SILENT_ALPHA),
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
        GAMMA_RADIATION_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildGammaCard(row, now());
    card.position = anchorOf(row);
    overlayHost.setEntries(
      GAMMA_RADIATION_OVERLAY_SOURCE_ID,
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
      GAMMA_RADIATION_LAYER_ID,
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
      if (
        pickId &&
        picking.isOwnedByOtherLayer(GAMMA_RADIATION_LAYER_ID, pickId)
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
    picking?.unregisterPickOwner?.(GAMMA_RADIATION_LAYER_ID);
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
          position: anchorOf(row),
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
    if (!_dots) return;
    const rows = ids.map((id) => _stationById.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    _dots.set(_stations.map(dotOf));
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: GAMMA_RADIATION_LAYER_ID,
    name: 'Radiation (Sweden)',
    icon: '☢️',
    source: 'Strålsäkerhetsmyndigheten',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer)
        throw new Error('Gamma radiation layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: GAMMA_RADIATION_LAYER_ID,
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
      overlayHost?.setVisible?.(GAMMA_RADIATION_OVERLAY_SOURCE_ID, true);
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
        const signature = JSON.stringify(
          snapshot.stations.map((row) => [row.id, row.updated, row.value]),
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
            console.warn('[Data:GammaRadiation] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Radiation data unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
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
