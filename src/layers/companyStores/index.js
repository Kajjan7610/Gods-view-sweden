import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { COMPANIES, storeColor, tidyStores } from './records.js';
import { COMPANY_STORES_OVERLAY_SOURCE_ID, buildStoreCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createCompanyStoresSource } from './source.js';

export const COMPANY_STORES_LAYER_ID = 'company-stores';
const PICK_PREFIX = 'se-store:';

/** A store on the ground: its bundled height above the ellipsoid, else 0. */
const storePosition = (row) => ({
  lon: row.point[0],
  lat: row.point[1],
  height: row.height ?? 0,
});
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const OUTLINE_COLOR = '#101418';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 2e4,
  nearValue: 1.3,
  far: 2e6,
  farValue: 0.6,
});

/** A store's dot as the set draws it. */
const dotOf = (row) => ({
  id: `${PICK_PREFIX}${row.id}`,
  pos: storePosition(row),
  height: 'clampGround',
  pixelSize: 8,
  color: storeColor(row),
  outlineColor: OUTLINE_COLOR,
  outlineWidth: 1.5,
  disableDepthTest: Number.POSITIVE_INFINITY,
  scaleByDistance: SCALE_BY_DISTANCE,
});

/**
 * Own one Swedish retail-chain display: the stores of a few large chains
 * from an OpenStreetMap snapshot, coloured by company and store concept, with
 * a chip per company to show or hide it and click-to-card selection. Share
 * links carry it as token 0k.
 */
export function createCompanyStoresLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Company stores require a snapshot source');
  let _viewer = null;
  let _dots = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _loaded = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _stores = [];
  let _facts = {};
  let _populationYear = null;
  const _shown = new Set(COMPANIES.map((company) => company.id));
  const _storeById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(COMPANY_STORES_LAYER_ID);
  const visible = () => _stores.filter((row) => _shown.has(row.company));

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _storeById.get(_selectedId) : null;
    if (!row || !_shown.has(row.company)) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        COMPANY_STORES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStoreCard(row, _facts, {
      stores: _stores,
      populationYear: _populationYear,
      linkable: Boolean(openExternal),
    });
    if (openExternal && row.website)
      card.activate = () => {
        openExternal(row.website);
        return true;
      };
    card.position = fromDegrees(row.point[0], row.point[1], row.height ?? 0);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      COMPANY_STORES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStore(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _storeById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      COMPANY_STORES_LAYER_ID,
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
        cardHit?.sourceId === COMPANY_STORES_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      ) {
        const row = _storeById.get(_selectedId);
        if (row?.website && openExternal) openExternal(row.website);
      }
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedStore(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(COMPANY_STORES_LAYER_ID, pickId)
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
    picking?.unregisterPickOwner?.(COMPANY_STORES_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(COMPANY_STORES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(COMPANY_STORES_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dots) return;
    _dots.set(visible().map(dotOf));
    publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: COMPANY_STORES_LAYER_ID,
    name: 'Retail Chains (Sweden)',
    icon: '🛒',
    source: 'OpenStreetMap',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Company stores layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: COMPANY_STORES_LAYER_ID,
        // Terrain only: clamping thousands of points to photorealistic 3D
        // tiles re-picks each one inside every tile that streams in,
        // seconds per frame. Without a globe the point keeps its height.
        clampTo: 'terrain',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(COMPANY_STORES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      requestRender();
    },

    async update() {
      if (!_enabled || !_dots) return false;
      // The snapshot is bundled; one read per session is enough.
      if (_loaded) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stores = tidyStores(snapshot.stores);
        _facts = Object.fromEntries(
          snapshot.companies.map((entry) => [entry.id, entry]),
        );
        _populationYear = snapshot.populationYear ?? null;
        _storeById.clear();
        for (const row of _stores) _storeById.set(row.id, row);
        _loaded = true;
        _lastUpdate = snapshot.osmBase ? Date.parse(snapshot.osmBase) : null;
        _lastError = null;
        render();
        console.log(`[Data:CompanyStores] Loaded: ${_stores.length} stores`);
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:CompanyStores] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Store data unavailable');
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _storeById.clear();
      _stores = [];
      _facts = {};
      _populationYear = null;
      _loaded = false;
      _dots?.dispose();
      _dots = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const legend = [];
      for (const company of COMPANIES) {
        if (!_shown.has(company.id)) continue;
        const rows = _stores.filter((row) => row.company === company.id);
        if (!rows.length) continue;
        if (company.concepts.length)
          for (const concept of company.concepts) {
            const count = rows.filter(
              (row) => row.brand === concept.brand,
            ).length;
            if (count)
              legend.push({
                label: concept.brand,
                color: concept.color,
                count,
              });
          }
        const other = company.concepts.length
          ? rows.filter(
              (row) => !company.concepts.some((c) => c.brand === row.brand),
            ).length
          : rows.length;
        if (other)
          legend.push({
            label: company.concepts.length
              ? t('{company}, other', { company: company.name })
              : company.name,
            color: company.color,
            count: other,
          });
      }
      return {
        chips: COMPANIES.map((company) => ({
          id: `company-${company.id}`,
          label: company.name,
          active: _shown.has(company.id),
          title: t('Show or hide {company} stores', { company: company.name }),
          onClick: () => {
            if (_shown.has(company.id)) _shown.delete(company.id);
            else _shown.add(company.id);
            render();
            _rowListener?.();
          },
        })),
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are the stores and pharmacies of large chains in Sweden as mapped in OpenStreetMap, coloured by company and store concept. Mappers collect them, not the companies, so a few may be missing or out of date. Only stores and pharmacies are shown. Click one for its address, whether it is open now, its size, the people living nearby, the nearest stop and the nearest other chains.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: visible().length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: false,
      };
    },
  };
  return layer;
}
