import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { formatNumber, getLocale, msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { foldText } from '../../ui/cardText.js';
import {
  AIR_QUALITY_BANDS,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  AIR_QUALITY_PROVIDERS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export {
  createCombinedAirQualitySource,
  createEcccAirQualitySource,
  createSmhiAirQualitySource,
} from './source.js';

export const AIR_QUALITY_LAYER_ID = 'air-quality';
export const AIR_QUALITY_MARKER_SET_ID = 'air-quality';
let instances = 0;

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;
/** Coverage line when more than one network reports. */
const MULTI_NETWORK_COVERAGE = msg(
  'Canada (ECCC AQHI) and Sweden (SMHI, European EAQI)',
);
const PICK_PREFIX = 'air-quality:';
const CARD_SOURCE_ID = 'air-quality-card';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const NOTE_LINES = 3;
// The clock follows the app's language, not the browser's.
const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

/** A reading's colour at `alpha`; an unreadable colour falls back to white. */
function withAlpha(css, alpha) {
  const [r, g, b] = cssColor(css) ?? [1, 1, 1];
  return [r, g, b, alpha];
}

/**
 * What a station measured, in the app's number format; a network that only
 * gives a note keeps it.
 */
function measuredNote(reading) {
  if (!Array.isArray(reading.measurements) || !reading.measurements.length)
    return reading.note;
  const parts = reading.measurements.map(
    ({ pollutant, value }) =>
      `${pollutant} ${formatNumber(value, { maximumFractionDigits: 1 })}`,
  );
  // i18n-ignore: unit
  return `${parts.join(' · ')} µg/m³`;
}

/**
 * Card for one station: its index and risk, what was measured, and when.
 * Card lines never wrap, so a network's note is folded into short lines.
 */
export function buildStationCard(reading) {
  const details = [`${reading.scale} ${reading.label} · ${t(reading.risk)}`];
  const note = measuredNote(reading);
  if (note) details.push(...foldText(note, NOTE_LINES));
  if (Number.isFinite(reading.observedMs))
    details.push(t('Measured {time}', { time: clock(reading.observedMs) }));
  details.push(String(reading.provider).toUpperCase());
  return {
    id: `air-quality-card:${reading.id}`,
    selected: true,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    interactive: false,
    title: t('AIR QUALITY · {station}', {
      station: reading.name.toUpperCase(),
    }),
    details,
    accent: reading.color,
  };
}

/**
 * Own one air-quality display, its refresh lifecycle, its readout card, and
 * the card of a clicked station.
 */
export function createAirQualityLayer({
  source,
  overlayHost,
  picking = null,
  pointer = null,
  // The clicks on the globe: the application passes its input dispatcher
  // (inputFor), which the exported package does not reach.
  input = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _markers = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;
  let _removeMoveEnd = null;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;

  const notify = () => rowControlsListener?.();
  const canSelect = () => !!(picking && input);
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(AIR_QUALITY_LAYER_ID);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const reading = _selectedId
      ? _readings.find((one) => one.id === _selectedId)
      : null;
    if (!reading) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = buildStationCard(reading);
    card.position = fromDegrees(reading.lon, reading.lat);
    _selectedCardId = card.id;
    overlayHost.setEntries(CARD_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  function pickedStation(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _readings.some((reading) => reading.id === id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(layer.id, (pickId) =>
      pickId.startsWith(PICK_PREFIX),
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
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y, {
        sourceId: CARD_SOURCE_ID,
      });
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedStation(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
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
    picking?.unregisterPickOwner?.(layer.id);
    _selectedId = null;
    _selectedCardId = null;
    overlayHost.clearSource(CARD_SOURCE_ID);
  }

  // The card lists the worst readings in view, so a settled camera re-reads
  // it; data refreshes alone are 20 minutes apart.
  const followCamera = (on) => {
    _removeMoveEnd?.();
    _removeMoveEnd = on
      ? ((_viewer && findCamera(_viewer)?.on?.('moveEnd', notify)) ?? null)
      : null;
  };

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () =>
    _viewer ? (findCamera(_viewer)?.viewRectangle() ?? null) : null;

  /**
   * Whether a station is on screen: inside the canvas and on the near side of
   * the globe. The view rectangle alone samples only the screen's corners, and
   * on a globe the middle of the top edge reaches further poleward than they
   * do, so stations there were left out of the list.
   */
  const viewTest = () => {
    const canvas = _viewer ? canvasOf(_viewer) : null;
    const width = canvas?.clientWidth;
    const height = canvas?.clientHeight;
    const query = width && height ? findQuery(_viewer) : null;
    if (!query) return viewRectangle();
    return (reading) => {
      const position = fromDegrees(reading.lon, reading.lat);
      if (query.isOccluded(position)) return false;
      const pixel = query.project(position);
      return (
        !!pixel &&
        pixel.x >= 0 &&
        pixel.x <= width &&
        pixel.y >= 0 &&
        pixel.y <= height
      );
    };
  };

  const layer = {
    id: AIR_QUALITY_LAYER_ID,
    name: 'Air quality',
    icon: '◍',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _markers = drawOf(viewer).shapes({
        id: `${AIR_QUALITY_MARKER_SET_ID}:${++instances}`,
        show: false,
      });
      _viewer = viewer;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_markers) _markers.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(CARD_SOURCE_ID, true);
      followCamera(true);
      installClickHandler();
      requestRender();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      followCamera(false);
      removeClickHandler();
      if (_markers) _markers.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(CARD_SOURCE_ID, false);
      requestRender();
      notify();
    },

    async update() {
      if (!_enabled || !_markers) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const readings = await source.getSnapshot({ signal: request.signal });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _readings = readings;
        this._render();
        // A refresh keeps the open card current, or closes it if the
        // station stopped reporting.
        if (_selectedId) publishSelectedCard();
        _count = _readings.length;
        _lastUpdate = Date.now();
        // A network that failed while another answered: its stations are
        // missing from the map, and the row says which one.
        const [failed] = readings.failures || [];
        _lastError = failed
          ? failed?.message || msg('Air quality request failed')
          : null;
        if (failed)
          console.warn('[Data:AirQuality] A network failed:', _lastError);
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Air quality request failed');
        console.warn('[Data:AirQuality] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Redraw the station markers and overlay labels from the current readings. */
    _render() {
      if (!_markers) return;
      const markers = [];
      const overlayEntries = [];
      for (const reading of _readings) {
        const position = fromDegrees(reading.lon, reading.lat);
        // A filled disc on the ground with static axes, as in the earthquake
        // layer: a per-frame axis re-tessellates clamped ground geometry
        // every frame. No outline: clamped to the ground, the default
        // renderer never drew one.
        markers.push({
          id: `${PICK_PREFIX}${reading.id}`,
          geometry: {
            kind: 'ellipse',
            center: { lon: reading.lon, lat: reading.lat },
            semiMajor: STATION_MARKER_RADIUS_M,
            semiMinor: STATION_MARKER_RADIUS_M,
          },
          fill: withAlpha(reading.color, 0.35),
          height: 'clampGround',
          clampTo: 'both',
          meta: {
            provider: reading.provider,
            scale: reading.scale,
            value: reading.value,
            band: reading.band,
            name: reading.name,
            zone: reading.zone,
            risk: reading.risk,
            observedMs: reading.observedMs,
            note: reading.note,
            lat: reading.lat,
            lon: reading.lon,
          },
        });
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            value: reading.value,
          }),
        );
      }
      _markers.set(markers);
      requestRender();
      if (_enabled) {
        overlayHost.setEntries(
          AIR_QUALITY_OVERLAY_SOURCE_ID,
          selectAirQualityOverlayCohort(overlayEntries),
          {
            cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      followCamera(false);
      removeClickHandler();
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(CARD_SOURCE_ID, false);
      _markers?.dispose();
      _markers = null;
      _viewer = null;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, and the worst
     * readings currently in view.
     *
     * `readout: true` renders the toggle and source line only; the card owns
     * the rest. Coverage is stated plainly because this layer is not global.
     */
    getRowControls() {
      // The networks behind the current readings (all of them before any
      // arrive): one network keeps its own coverage line, several share one.
      const present = Object.values(AIR_QUALITY_PROVIDERS).filter((provider) =>
        _readings.some((reading) => reading.provider === provider.id),
      );
      const providers = present.length
        ? present
        : Object.values(AIR_QUALITY_PROVIDERS);
      const [provider] = providers;
      const inView = readingsInView(_readings, viewTest(), READOUT_LIMIT);
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does. A provider's own
      // error text has no catalog entry and shows as it came.
      return {
        readout: true,
        summary: {
          label: t(provider.label),
          coverage:
            providers.length === 1
              ? t(provider.coverage)
              : t(MULTI_NETWORK_COVERAGE),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: providers
            .map((one) => `${one.network} · ${one.scale}`)
            .join(' · '),
          status: _lastError
            ? translateFeedError(_lastError)
            : _count === 0
              ? _lastUpdate === null
                ? t('No readings available')
                : t('No current readings')
              : tn(
                  _count,
                  '{count} station reporting',
                  '{count} stations reporting',
                ),
          units: providers.map((one) => one.scale).join(' / '),
        },
        legend: AIR_QUALITY_BANDS.map((band) => ({
          color: band.color,
          label: t(band.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Highest air-quality readings in view'),
          items: inView.map((reading, index) => ({
            id: reading.id,
            ordinal: index + 1,
            lead: `${reading.scale} ${reading.label}`,
            text: `${reading.name} · ${t(reading.risk)}`,
            accent: reading.color,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
    },

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale: _lastUpdate !== null && readingsAreStale(_readings),
      };
    },
  };
  return layer;
}
