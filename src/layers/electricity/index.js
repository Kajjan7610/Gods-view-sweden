import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
import {
  PRICE_CLASSES,
  priceAt,
  priceClass,
  priceColor,
  summarizeDay,
} from './records.js';
import {
  ELECTRICITY_OVERLAY_SOURCE_ID,
  buildZoneCard,
  formatSek,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createElectricityPricesSource } from './source.js';

const PICK_PREFIX = 'se-elpris:';
const LABEL_SOURCE_ID = 'electricity-price-labels';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 8,
  collisionCapacity: 8,
  moving: false,
});
const CLASS_LABELS = Object.freeze({
  'very-low': msg('Up to 0.50 kr/kWh'),
  low: msg('0.50 to 1 kr/kWh'),
  medium: msg('1 to 2 kr/kWh'),
  high: msg('2 to 3 kr/kWh'),
  'very-high': msg('Above 3 kr/kWh'),
});

/**
 * Own one Swedish electricity price display: the day-ahead spot price of
 * each bidding zone (SE1–SE4) as a coloured point with a price label —
 * now, today's mean or tomorrow's mean — and a card with the day's range.
 * Share links carry it as token 0w.
 */
export function createElectricityPricesLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Electricity prices require a snapshot source');
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
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _zones = [];
  /** 'now', 'today' (mean) or 'tomorrow' (mean). */
  let _mode = 'now';
  const _zoneById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  /** The price a zone is coloured and labelled by in the current mode. */
  function shownPrice(zone, nowMs = now()) {
    if (_mode === 'today') return summarizeDay(zone.today)?.mean ?? null;
    if (_mode === 'tomorrow') return summarizeDay(zone.tomorrow)?.mean ?? null;
    return priceAt(zone.today, nowMs)?.sek ?? null;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const zone = _selectedId ? _zoneById.get(_selectedId) : null;
    if (!zone) {
      _selectedId = null;
      overlayHost.setEntries(
        ELECTRICITY_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildZoneCard(zone, now());
    card.position = position(zone);
    overlayHost.setEntries(
      ELECTRICITY_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedZone(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _zoneById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      // A card under the click, this layer's or another's, is not the ground.
      if (overlayHost.hitTest?.(click.position?.x, click.position?.y)) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedZone(picked) : null;
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
    for (const id of [ELECTRICITY_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  function publishLabels() {
    if (!overlayHost) return;
    const entries = _enabled
      ? _zones.map((zone) => {
          const price = shownPrice(zone);
          return {
            id: `electricity-label:${zone.id}`,
            position: position(zone),
            variant: 'label',
            title: Number.isFinite(price)
              ? t('{zone} · {price} kr', {
                  zone: zone.id,
                  price: formatSek(price),
                })
              : zone.id,
            accent: priceColor(price),
            priority: 1000,
            collisionGroup: 'ambient-label',
            paintLane: 'ambient-label',
            interactive: false,
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 14,
            verticalOnly: true,
            placement: 'above',
          };
        })
      : [];
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
        const row = _zoneById.get(id);
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
      for (const zone of _zones) {
        entities.add({
          id: `${PICK_PREFIX}${zone.id}`,
          position: position(zone),
          point: {
            pixelSize: 20,
            color: Cesium.Color.fromCssColorString(
              priceColor(shownPrice(zone)),
            ),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
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
    id: 'electricity-prices',
    name: 'Electricity Prices (Sweden)',
    icon: '⚡',
    source: 'elprisetjustnu.se',
    // The price changes every quarter-hour; the proxy caches the day files.
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('Electricity prices layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('electricity-prices');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(ELECTRICITY_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
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
            : now();
        _lastError = null;
        _zones = snapshot.zones;
        _zoneById.clear();
        for (const zone of _zones) _zoneById.set(zone.id, zone);
        // Rendered on every update: the current quarter-hour moves on.
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_zones);
        try {
          render();
        } catch (e) {
          // Drawn again at the next update, a minute on.
          console.warn('[Data:ElectricityPrices] Draw error:', e?.message || e);
          _lastError = e?.message || msg('Electricity prices unavailable');
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:ElectricityPrices] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Electricity prices unavailable');
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
      _zoneById.clear();
      _zones = [];
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
      const counts = new Map();
      for (const zone of _zones) {
        const entry = priceClass(shownPrice(zone));
        if (entry) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
      }
      const legend = PRICE_CLASSES.map(({ id, color }) => ({
        label: t(CLASS_LABELS[id]),
        color,
        count: counts.get(id) || 0,
      })).filter((item) => item.count > 0);
      const hasTomorrow = _zones.some((zone) => zone.tomorrow?.length);
      return {
        chips: [
          {
            id: 'now',
            label: t('NOW'),
            active: _mode === 'now',
            title: t('Colour zones by the price this quarter-hour'),
            onClick: () => setMode('now'),
          },
          {
            id: 'today',
            label: t('TODAY'),
            active: _mode === 'today',
            title: t('Colour zones by today’s mean price'),
            onClick: () => setMode('today'),
          },
          {
            id: 'tomorrow',
            label: t('TOMORROW'),
            active: _mode === 'tomorrow',
            disabled: !hasTomorrow,
            title: t(
              'Colour zones by tomorrow’s mean price, once the day-ahead auction has published it',
            ),
            onClick: () => setMode('tomorrow'),
          },
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Points are the four bidding zones (SE1 Luleå, SE2 Sundsvall, SE3 Stockholm, SE4 Malmö), coloured by spot price excluding VAT, grid fee and energy tax. Click a zone for today’s range and tomorrow.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: _zones.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
