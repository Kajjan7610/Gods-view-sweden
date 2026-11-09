import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { COMPANIES, storeColor } from './records.js';
import { COMPANY_STORES_OVERLAY_SOURCE_ID, buildStoreCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createCompanyStoresSource } from './source.js';

const PICK_PREFIX = 'se-store:';

/** A store on the ground: its bundled height above the ellipsoid, else 0. */
const storePosition = (row) =>
  Cesium.Cartesian3.fromDegrees(row.point[0], row.point[1], row.height ?? 0);
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
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
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Company stores require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
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

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
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
    if (card.interactive)
      card.activate = () => {
        openExternal(row.website);
        return true;
      };
    card.position = storePosition(row);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      COMPANY_STORES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStore(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _storeById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: COMPANY_STORES_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const row = _storeById.get(_selectedId);
        if (row?.website && openExternal) openExternal(row.website);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStore(picked) : null;
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
    overlayHost.clearSource(COMPANY_STORES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(COMPANY_STORES_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      for (const row of visible()) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: storePosition(row),
          point: {
            pixelSize: 8,
            color: Cesium.Color.fromCssColorString(storeColor(row)),
            outlineColor: Cesium.Color.fromCssColorString('#101418'),
            outlineWidth: 1.5,
            // Terrain only: clamping thousands of points to photorealistic 3D
            // tiles re-picks each one inside every tile that streams in,
            // seconds per frame. Without a globe the point keeps its height.
            heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.3, 2e6, 0.6),
          },
        });
      }
    } finally {
      entities.resumeEvents();
    }
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'company-stores',
    name: 'Retail Chains (Sweden)',
    icon: '🛒',
    source: 'OpenStreetMap',
    updateInterval: 24 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Company stores layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('company-stores');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(COMPANY_STORES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      // The snapshot is bundled; one read per session is enough.
      if (_loaded) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stores = snapshot.stores;
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

    destroy(viewer = _viewer) {
      layer.disable();
      _storeById.clear();
      _stores = [];
      _facts = {};
      _populationYear = null;
      _loaded = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
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
