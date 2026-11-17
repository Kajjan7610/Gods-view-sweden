import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { AGE_CLASSES, ageClass } from './records.js';
import {
  LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
  buildStrikeCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createLightningStrikesSource } from './source.js';

export const LIGHTNING_STRIKES_LAYER_ID = 'lightning-strikes';
const PICK_PREFIX = 'se-lightning:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

// One look per age class and kind, shared by every dot: nothing is made per
// stroke but its position.
const SCALE = Object.freeze({
  near: 2e4,
  nearValue: 1.3,
  far: 3e6,
  farValue: 0.7,
});
const LOOKS = AGE_CLASSES.map((age) => {
  const [r, g, b] = cssColor(age.color);
  return {
    ground: Object.freeze({
      pixelSize: 9,
      color: age.color,
      outlineColor: '#3a1600',
      outlineWidth: 1.5,
    }),
    cloud: Object.freeze({
      pixelSize: 6,
      color: Object.freeze([r, g, b, 0.75]),
      outlineColor: '#5c3b00',
      outlineWidth: 1,
    }),
  };
});
const look = (row, index) =>
  LOOKS[index][row.kind === 'cloud' ? 'cloud' : 'ground'];

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
  picking = null,
  pointer = null,
  now = () => Date.now(),
  geoid = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
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
  const position = ([lon, lat]) => ({
    lon,
    lat,
    height: _geoidReady ? geoid.heightAt(lat, lon) : 0,
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
  let _truncated = false;
  let _selectedId = null;
  let _strikes = [];
  const _strikeById = new Map();
  // Stroke id → index of the age class its dot is drawn in.
  const _drawn = new Map();
  // Whether the next drawing starts over instead of updating in place.
  let _redrawAll = true;

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(LIGHTNING_STRIKES_LAYER_ID);
  /** Strokes still inside the hour, which ages on between refreshes. */
  const current = () =>
    _strikes.filter((row) => ageClass(now() - row.at) !== null);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _strikeById.get(_selectedId) : null;
    // A stroke past the hour loses its dot, and its card goes with it.
    if (!row || !ageClass(now() - row.at)) {
      _selectedId = null;
      overlayHost.setEntries(
        LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildStrikeCard(row, now());
    const at = position(row.point);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    overlayHost.setEntries(
      LIGHTNING_STRIKES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedStrike(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _strikeById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      LIGHTNING_STRIKES_LAYER_ID,
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
      const hit = pickedStrike(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(LIGHTNING_STRIKES_LAYER_ID, pickId)
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
    picking?.unregisterPickOwner?.(LIGHTNING_STRIKES_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID, false);
  }

  /** A stroke's dot as the set draws it, in the look of age class `index`. */
  const dotOf = (row, index) => {
    const style = look(row, index);
    return {
      id: `${PICK_PREFIX}${row.id}`,
      pos: position(row.point),
      height: 'clampGround',
      pixelSize: style.pixelSize,
      color: style.color,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      disableDepthTest: Number.POSITIVE_INFINITY,
      scaleByDistance: SCALE,
    };
  };

  function render() {
    if (!_dots) return;
    const nowMs = now();
    // Stroke id → index of its age class, for those still inside the hour.
    const next = new Map();
    for (const row of _strikes) {
      const age = ageClass(nowMs - row.at);
      if (age) next.set(row.id, AGE_CLASSES.indexOf(age));
    }
    const full = _redrawAll;
    // Until this drawing is done: one that fails is made again from scratch.
    _redrawAll = true;
    if (full) {
      _drawn.clear();
      const items = [];
      // Oldest first, so the newest strokes draw on top.
      for (let i = _strikes.length - 1; i >= 0; i--) {
        const row = _strikes[i];
        const index = next.get(row.id);
        if (index === undefined || _drawn.has(row.id)) continue;
        items.push(dotOf(row, index));
        _drawn.set(row.id, index);
      }
      _dots.set(items);
    } else {
      // In place: a dot already drawn only ever changes colour, so strokes
      // past the hour go, new ones are added last (on top) and the rest stay.
      const gone = [];
      for (const id of _drawn.keys())
        if (!next.has(id)) {
          gone.push(`${PICK_PREFIX}${id}`);
          _drawn.delete(id);
        }
      const changed = [];
      for (let i = _strikes.length - 1; i >= 0; i--) {
        const row = _strikes[i];
        const index = next.get(row.id);
        if (index === undefined || _drawn.get(row.id) === index) continue;
        changed.push(dotOf(row, index));
        _drawn.set(row.id, index);
      }
      if (gone.length) _dots.remove(gone);
      if (changed.length) _dots.upsert(changed);
    }
    _redrawAll = false;
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  const layer = {
    id: LIGHTNING_STRIKES_LAYER_ID,
    name: 'Lightning Strikes (Sweden)',
    icon: '⚡',
    source: 'DMI',
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Lightning strikes layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: LIGHTNING_STRIKES_LAYER_ID,
        // With the geoid the dots clamp to terrain only: clamping thousands
        // of dots to 3D tiles freezes the app (../groundHeights.js).
        clampTo: geoid ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(LIGHTNING_STRIKES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      requestRender();
      // The geoid grid is code-split; load it when the layer is first used.
      if (geoid && !_geoidAsked) {
        _geoidAsked = true;
        geoid
          .ensureReady()
          .then(() => {
            _geoidReady = true;
            // Every dot moves to its new height: one drawing from scratch.
            _redrawAll = true;
            render();
          })
          .catch((error) => {
            // A grid that did not load is asked for again the next time the
            // layer is turned on; a drawing that failed is made again by the
            // next round.
            _geoidAsked = _geoidReady;
            _signature = null;
            console.warn(
              _geoidReady
                ? '[Data:LightningStrikes] Draw error:'
                : '[Data:LightningStrikes] Geoid unavailable:',
              error?.message || error,
            );
          });
      }
    },

    disable() {
      _request?.abort();
      _request = null;
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
      let drawing = false;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stale = snapshot.stale;
        _truncated = snapshot.truncated;
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : now();
        _lastError = null;
        _strikes = snapshot.strikes;
        _strikeById.clear();
        for (const row of _strikes) _strikeById.set(row.id, row);
        // Colours follow age, so a quiet minute still repaints.
        const signature = `${Math.floor(now() / 60_000)}:${_strikes[0]?.id ?? ''}:${_strikes.length}`;
        if (signature !== _signature) {
          // Kept once drawn; a drawing that failed is not, so the next round
          // makes it again.
          _signature = null;
          drawing = true;
          render();
          drawing = false;
          _signature = signature;
          console.log(
            `[Data:LightningStrikes] Updated: ${_strikes.length} strokes`,
          );
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(
          drawing
            ? '[Data:LightningStrikes] Draw error:'
            : '[Data:LightningStrikes] Fetch error:',
          e?.message || e,
        );
        _lastError = e?.message || msg('Lightning data unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _strikeById.clear();
      _strikes = [];
      _signature = null;
      _drawn.clear();
      _redrawAll = true;
      _dots?.dispose();
      _dots = null;
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
