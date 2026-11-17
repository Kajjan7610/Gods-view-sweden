import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
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

export const ELECTRICITY_PRICES_LAYER_ID = 'electricity-prices';
const PICK_PREFIX = 'se-elpris:';
const OUTLINE_COLOR = '#ffffff';
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
  picking = null,
  pointer = null,
  terrain = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Electricity prices require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids));
  const position = (row) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(row.id),
  });
  /** Where an overlay entry for `row` sits (ECEF). */
  const placeOf = (row) => {
    const at = position(row);
    return fromDegrees(at.lon, at.lat, at.height);
  };
  let _viewer = null;
  let _dots = null;
  // The zones drawn now, each with the price its dot is coloured by.
  let _drawn = new Map();
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

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(ELECTRICITY_PRICES_LAYER_ID);

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
    card.position = placeOf(zone);
    overlayHost.setEntries(
      ELECTRICITY_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedZone(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _zoneById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      ELECTRICITY_PRICES_LAYER_ID,
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
      const hit = pickedZone(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(ELECTRICITY_PRICES_LAYER_ID, pickId)
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
    picking?.unregisterPickOwner?.(ELECTRICITY_PRICES_LAYER_ID);
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
            position: placeOf(zone),
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

  /** A zone's dot as the set draws it, coloured by `price`. */
  const dotOf = (zone, price) => ({
    id: `${PICK_PREFIX}${zone.id}`,
    pos: position(zone),
    height: 'clampGround',
    pixelSize: 20,
    color: priceColor(price),
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 3,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    // Only dots drawn now move, coloured as they were drawn.
    const items = [];
    for (const id of ids) {
      const drawn = _drawn.get(id);
      if (drawn) items.push(dotOf(drawn.zone, drawn.price));
    }
    if (items.length) _dots.upsert(items);
    publishLabels();
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    const nowMs = now();
    const drawn = new Map(
      _zones.map((zone) => [zone.id, { zone, price: shownPrice(zone, nowMs) }]),
    );
    _drawn = new Map();
    _dots.set([...drawn.values()].map(({ zone, price }) => dotOf(zone, price)));
    _drawn = drawn;
    publishLabels();
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  function setMode(mode) {
    if (_mode === mode) return;
    _mode = mode;
    render();
    _rowListener?.();
  }

  const layer = {
    id: ELECTRICITY_PRICES_LAYER_ID,
    name: 'Electricity Prices (Sweden)',
    icon: '⚡',
    source: 'elprisetjustnu.se',
    // The price changes every quarter-hour; the proxy caches the day files.
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('Electricity prices layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: ELECTRICITY_PRICES_LAYER_ID,
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
      overlayHost?.setVisible?.(ELECTRICITY_OVERLAY_SOURCE_ID, true);
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

    destroy() {
      layer.disable();
      _ground.clear();
      _zoneById.clear();
      _zones = [];
      _drawn = new Map();
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

    /**
     * Swedish fork: the spot price this quarter hour per zone, in öre per
     * kWh, for a story's captions (src/stories/liveCaption.js).
     */
    storyFacts() {
      const facts = {};
      const nowMs = now();
      for (const zone of _zones) {
        const sek = priceAt(zone.today, nowMs)?.sek;
        if (Number.isFinite(sek))
          facts[`ore.${zone.id}`] = Math.round(sek * 1000) / 10;
      }
      return facts;
    },
  };
  return layer;
}
