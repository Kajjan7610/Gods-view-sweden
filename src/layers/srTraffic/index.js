import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { liftEntities } from '../liftEntities.js';
import { redrawEntities } from '../redrawEntities.js';
import { SR_PRIORITIES, priorityColor } from './records.js';
import {
  PRIORITY_LABELS,
  SR_TRAFFIC_OVERLAY_SOURCE_ID,
  SR_TRAFFIC_PAGE,
  buildSrCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSrTrafficSource } from './source.js';

const PICK_PREFIX = 'se-srtrafik:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Dot size by priority: the serious ones stand out. */
const PRIORITY_PIXELS = Object.freeze({ 1: 16, 2: 13, 3: 10, 4: 8, 5: 7 });

/**
 * Own one Swedish traffic report display: the messages Sveriges Radio's
 * traffic desks publish, as dots coloured and sized by priority, filtered by
 * category, with click-to-card selection. Share links carry it as token 0v.
 */
export function createSrTrafficLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  terrain = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SR traffic requires a snapshot source');
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
  let _messages = [];
  const _show = { road: true, transit: true, planned: false, other: true };
  const _messageById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const visibleMessages = () =>
    _messages.filter((row) => _show[row.category] !== false);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _messageById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        SR_TRAFFIC_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildSrCard(row, { linkable: Boolean(openExternal) });
    card.position = position(row);
    if (card.accessibilityLabel)
      card.activate = () => {
        openExternal(SR_TRAFFIC_PAGE);
        return true;
      };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SR_TRAFFIC_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedMessage(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _messageById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
      );
      // The selected card leads to SR's traffic page.
      if (
        cardHit?.sourceId === SR_TRAFFIC_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId &&
        openExternal
      )
        openExternal(SR_TRAFFIC_PAGE);
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedMessage(picked) : null;
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

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(SR_TRAFFIC_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(SR_TRAFFIC_OVERLAY_SOURCE_ID, false);
    }
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dataSource) return;
    liftEntities(
      _dataSource.entities,
      ids,
      (id) => `${PICK_PREFIX}${id}`,
      (id) => {
        const row = _messageById.get(id);
        return row && position(row);
      },
    );
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const shown = visibleMessages();
    redrawEntities(entities, () => {
      // Least serious first, so the serious ones are drawn on top.
      for (const row of [...shown].reverse()) {
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row),
          point: {
            pixelSize: PRIORITY_PIXELS[row.priority] || 7,
            color: Cesium.Color.fromCssColorString(priorityColor(row.priority)),
            outlineColor:
              row.priority <= 2
                ? Cesium.Color.WHITE
                : Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: row.priority <= 2 ? 2.5 : 1.5,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    });
    if (_selectedId && !shown.some((row) => row.id === _selectedId))
      _selectedId = null;
    publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  function toggle(key) {
    _show[key] = !_show[key];
    render();
    _rowListener?.();
  }

  const layer = {
    id: 'sr-traffic',
    name: 'Traffic Reports (Sweden)',
    icon: '📻',
    source: 'Sveriges Radio',
    updateInterval: 180000,

    init(viewer) {
      if (_viewer) throw new Error('SR traffic layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sr-traffic');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SR_TRAFFIC_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      _lastError = null;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
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
        // Always the newest rows, so a card reads the text SR has now; the
        // dots are drawn again only when one of them would look different.
        _messages = snapshot.messages;
        _messageById.clear();
        for (const row of _messages) _messageById.set(row.id, row);
        // Heights first: the ones this browser kept are drawn at once.
        _ground.place(_messages);
        const signature = JSON.stringify(
          _messages.map((row) => [
            row.id,
            row.priority,
            row.category,
            row.point,
          ]),
        );
        if (signature !== _signature) {
          // Not trusted until drawn: a drawing that fails is made again.
          _signature = null;
          try {
            render();
          } catch (e) {
            console.warn('[Data:SrTraffic] Draw error:', e?.message || e);
            _lastError = e?.message || msg('SR traffic messages unavailable');
            _rowListener?.();
            return true;
          }
          _signature = signature;
          console.log(`[Data:SrTraffic] Updated: ${_messages.length} messages`);
        } else if (_selectedId) publishSelectedCard();
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SrTraffic] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('SR traffic messages unavailable');
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
      _messageById.clear();
      _messages = [];
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
      const shown = visibleMessages();
      const legend = SR_PRIORITIES.map(({ id, color }) => ({
        label: t(PRIORITY_LABELS[id]),
        color,
        count: shown.filter((row) => row.priority === id).length,
      })).filter((item) => item.count > 0);
      const chip = (id, label, title) => ({
        id,
        label,
        active: _show[id],
        title,
        onClick: () => toggle(id),
      });
      return {
        chips: [
          chip('road', t('ROAD TRAFFIC'), t('Road incidents and closures')),
          chip(
            'transit',
            t('PUBLIC TRANSPORT'),
            t('Train, bus and ferry disruptions'),
          ),
          chip(
            'planned',
            t('PLANNED'),
            t('Planned works and disruptions announced in advance'),
          ),
          chip('other', t('OTHER'), t('Other traffic information')),
        ],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are the traffic reports Sveriges Radio publishes, coloured and sized by priority. Click a dot for the report, in Swedish.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: visibleMessages().length,
        messages: _messages.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
