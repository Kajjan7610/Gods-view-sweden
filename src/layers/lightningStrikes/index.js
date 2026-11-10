import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { redrawEntities } from '../redrawEntities.js';
import { AGE_CLASSES, ageClass } from './records.js';
import {
  LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
  buildStrikeCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createLightningStrikesSource } from './source.js';

const PICK_PREFIX = 'se-lightning:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** The legend row for one age class. */
function ageLabel(entry) {
  return t('{from}–{to} min ago', { from: entry.min, to: entry.max });
}

/**
 * Own one lightning stroke display: DMI's triangulated strokes over Sweden
 * and its neighbours in the last hour, coloured by age, ground strokes
 * larger than cloud flashes, with click-to-card selection. Share links carry
 * it as token 0l.
 */
export function createLightningStrikesLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  now = () => Date.now(),
  geoid = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Lightning strikes require a snapshot source');
  // Strokes are too many and too short-lived to look up ground heights, and
  // their positions are good to 0.5–2 km: they sit at sea level by the bundled
  // geoid, clamped to terrain only (see ../groundHeights.js for why not to
  // clamp them to 3D tiles). Only the height is set, never the position.
  // `geoid`: {ensureReady(): Promise, heightAt(lat, lon): number}.
  let _geoidReady = false;
  let _geoidAsked = false;
  const position = ([lon, lat]) =>
    Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      _geoidReady ? geoid.heightAt(lat, lon) : 0,
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
  let _truncated = false;
  let _selectedId = null;
  let _selectedCardId = null;
  let _strikes = [];
  const _strikeById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  /** Strokes still inside the hour, which ages on between refreshes. */
  const current = () =>
    _strikes.filter((row) => ageClass(now() - row.at) !== null);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _strikeById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStrikeCard(row, now());
    card.position = position(row.point);
    _selectedCardId = card.id;
    overlayHost.setEntries(
      LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStrike(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _strikeById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: LIGHTNING_STRIKES_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedStrike(picked) : null;
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
    overlayHost.clearSource(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID, false);
  }

  function render() {
    if (!_dataSource) return;
    const nowMs = now();
    const entities = _dataSource.entities;
    redrawEntities(entities, () => {
      // Oldest first, so the newest strokes draw on top.
      for (const row of [..._strikes].reverse()) {
        const age = ageClass(nowMs - row.at);
        if (!age) continue;
        const ground = row.kind !== 'cloud';
        entities.add({
          id: `${PICK_PREFIX}${row.id}`,
          position: position(row.point),
          point: {
            pixelSize: ground ? 9 : 6,
            color: Cesium.Color.fromCssColorString(age.color).withAlpha(
              ground ? 1 : 0.75,
            ),
            outlineColor: Cesium.Color.fromCssColorString(
              ground ? '#3a1600' : '#5c3b00',
            ),
            outlineWidth: ground ? 1.5 : 1,
            heightReference: geoid
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e4, 1.3, 3e6, 0.7),
          },
        });
      }
    });
    if (_selectedId) publishSelectedCard();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'lightning-strikes',
    name: 'Lightning Strikes (Sweden)',
    icon: '⚡',
    source: 'DMI',
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Lightning strikes layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('lightning-strikes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      // The geoid grid is code-split; load it when the layer is first used.
      if (geoid && !_geoidAsked) {
        _geoidAsked = true;
        geoid
          .ensureReady()
          .then(() => {
            _geoidReady = true;
            render();
          })
          .catch((error) =>
            console.warn(
              '[Data:LightningStrikes] Geoid unavailable:',
              error?.message || error,
            ),
          );
      }
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
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stale = snapshot.stale;
        _truncated = snapshot.truncated;
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        _lastError = null;
        _strikes = snapshot.strikes;
        _strikeById.clear();
        for (const row of _strikes) _strikeById.set(row.id, row);
        // Colours follow age, so a quiet minute still repaints.
        const signature = `${Math.floor(now() / 60_000)}:${_strikes[0]?.id ?? ''}:${_strikes.length}`;
        if (signature !== _signature) {
          _signature = signature;
          render();
          console.log(
            `[Data:LightningStrikes] Updated: ${_strikes.length} strokes`,
          );
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:LightningStrikes] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Lightning data unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _strikeById.clear();
      _strikes = [];
      _signature = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _truncated = false;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const nowMs = now();
      const shown = current();
      const legend = AGE_CLASSES.map((entry) => ({
        label: ageLabel(entry),
        color: entry.color,
        count: shown.filter((row) => ageClass(nowMs - row.at) === entry).length,
      }));
      const blurb = t(
        'Dots are lightning strokes located by DMI’s sensor network and its neighbours’ in the last hour, coloured by age: white is the last five minutes. Large dots strike the ground; small ones stay in the cloud. Positions are within about 0.5–2 km near Denmark and less precise farther north. Not a safety warning: when thunder can be heard, lightning is close enough to strike.',
      );
      return {
        legend: legend.map((item, index) =>
          index === 0 ? { ...item, blurb } : item,
        ),
        info:
          _strikes.length || _lastUpdate
            ? shown.length === 0
              ? t('No lightning in the last hour')
              : _truncated
                ? t('Showing the newest 20,000 strokes')
                : ''
            : '',
      };
    },

    getStats() {
      return {
        count: current().length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
