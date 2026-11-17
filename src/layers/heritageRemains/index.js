import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createGroundHeights } from '../groundHeights.js';
import {
  ASSESSMENT,
  ASSESSMENTS,
  clipRemainsBox,
  remainUrl,
} from './records.js';
import {
  ASSESSMENT_LABELS,
  HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
  buildRemainCard,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createHeritageRemainsSource } from './source.js';

export const HERITAGE_REMAINS_LAYER_ID = 'heritage-remains';
const PICK_PREFIX = 'se-remain:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Remains show below this camera height; above it, a hint to zoom in. */
export const REMAINS_MAX_HEIGHT_M = 12_000;
/** The nearest this many to the map centre are drawn. */
const SHOWN = 1500;
const MOVE_SETTLE_MS = 400;
const OUTLINE_COLOR = '#1a120b';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 300,
  nearValue: 1.3,
  far: 12000,
  farValue: 0.7,
});

/** Dot size: a protected remain reads a little larger. */
const pixelSize = (row) =>
  row.assessment === 'fl' ? 8 : row.assessment === 'mfl' ? 7 : 6;

/**
 * Own one display of Sweden's cultural-heritage remains: the remains RAÄ
 * registers in Kulturmiljöregistret, drawn for the view once the camera is
 * low enough, the nearest to the centre first, coloured by their legal
 * assessment, with a card that opens the remain at RAÄ.
 * Share links carry it as token 0c.
 */
export function createHeritageRemainsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  openExternal = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Heritage remains require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  const _ground = createGroundHeights(terrain, (ids) => lift(ids), {
    passing: true,
  });
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
  let _removeMove = null;
  let _moveTimer = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _zoomIn = true;
  let _capped = false;
  let _total = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _shown = [];
  const _byId = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(HERITAGE_REMAINS_LAYER_ID);

  /** A remain's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: pixelSize(row),
    color: ASSESSMENT[row.assessment]?.color ?? ASSESSMENT.none.color,
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  function openSelected() {
    const row = _selectedId ? _byId.get(_selectedId) : null;
    if (!row?.page || !openExternal) return false;
    openExternal(remainUrl(row.page));
    return true;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _byId.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const linkable = Boolean(openExternal && row.page);
    const card = buildRemainCard(row, { linkable });
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    if (linkable) card.activate = () => openSelected();
    _selectedCardId = card.id;
    overlayHost.setEntries(
      HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRemain(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _byId.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      HERITAGE_REMAINS_LAYER_ID,
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
      // A click on this layer's own card opens the remain at RAÄ.
      if (
        cardHit?.sourceId === HERITAGE_REMAINS_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      )
        openSelected();
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedRemain(pickId);
      if (hit) {
        _selectedId = hit;
        publishSelectedCard();
        requestRender();
        _rowListener?.();
        return;
      }
      if (
        pickId &&
        picking.isOwnedByOtherLayer(HERITAGE_REMAINS_LAYER_ID, pickId)
      )
        return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
        _rowListener?.();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(HERITAGE_REMAINS_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(HERITAGE_REMAINS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(HERITAGE_REMAINS_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids.map((id) => _byId.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Farthest first, so the nearest draw on top where dots meet.
    _dots.set([..._shown].reverse().map(dotOf));
    if (_selectedId) publishSelectedCard();
    requestRender();
  }

  /** The ground under the canvas centre, in degrees, or null. */
  function viewCentre() {
    const query = findQuery(_viewer);
    const canvas = canvasOf(_viewer);
    if (typeof query?.pickEllipsoid !== 'function' || !canvas) return null;
    const middle = query.pickEllipsoid(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const ground = middle ? toLonLatH(middle) : null;
    return ground ? [ground.lon, ground.lat] : null;
  }

  /** The view as a box and its centre, or null when the camera is too high. */
  function viewQuery() {
    const camera = _viewer ? findCamera(_viewer) : null;
    const pose = camera?.pose();
    const height = pose?.height;
    if (!Number.isFinite(height) || height > REMAINS_MAX_HEIGHT_M) return null;
    const rect = camera.viewRectangle?.();
    if (!rect) return null;
    const center = viewCentre() ?? [pose.lon, pose.lat];
    return {
      // A tilted view reaches the horizon: ask for the part about the centre.
      bbox: clipRemainsBox(
        [rect.west, rect.south, rect.east, rect.north],
        center,
      ),
      center,
    };
  }

  /** Forget the view's remains: the camera is too high, or the layer off. */
  function clearRows() {
    _zoomIn = true;
    _capped = false;
    _shown = [];
    _total = null;
    _byId.clear();
    _ground.cancel();
  }

  async function refresh() {
    if (!_enabled || !_dots) return false;
    _request?.abort();
    const query = viewQuery();
    if (!query) {
      _request = null;
      clearRows();
      if (_selectedId) publishSelectedCard();
      render();
      _rowListener?.();
      return true;
    }
    const request = new AbortController();
    _request = request;
    try {
      const snapshot = await source.getSnapshot({
        signal: request.signal,
        ...query,
        limit: SHOWN,
      });
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      _stale = snapshot.stale;
      _lastUpdate =
        _stale && Number.isFinite(snapshot.fetchedAt)
          ? snapshot.fetchedAt
          : Date.now();
      _lastError = null;
      _zoomIn = snapshot.tooWide;
      _capped = snapshot.capped;
      _shown = snapshot.tooWide ? [] : snapshot.remains;
      _total = snapshot.total;
      _byId.clear();
      for (const row of _shown) _byId.set(row.id, row);
      if (_selectedId && !_byId.has(_selectedId)) {
        _selectedId = null;
        publishSelectedCard();
      }
      _ground.place(_shown);
      render();
      _rowListener?.();
      return true;
    } catch (e) {
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      console.warn('[Data:HeritageRemains] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Heritage remains unavailable');
      _stale = false;
      _rowListener?.();
      return true;
    } finally {
      if (_request === request) _request = null;
    }
  }

  function scheduleRefresh() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
  }

  const layer = {
    id: HERITAGE_REMAINS_LAYER_ID,
    name: 'Ancient Monuments (Sweden)',
    icon: '🪨',
    source: 'Riksantikvarieämbetet',
    updateInterval: 12 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Heritage remains layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: HERITAGE_REMAINS_LAYER_ID,
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
      overlayHost?.setVisible?.(HERITAGE_REMAINS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      _removeMove ??=
        (_viewer && findCamera(_viewer)?.on('moveEnd', scheduleRefresh)) ??
        null;
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      clearRows();
      render();
    },

    update() {
      return refresh();
    },

    /** Select a remain in the view by its id (tools and tests). */
    setParams(params = {}) {
      if (!_enabled) return false;
      const row = params.remainId ? _byId.get(String(params.remainId)) : null;
      if (!row) return false;
      _selectedId = row.id;
      publishSelectedCard();
      _rowListener?.();
      return true;
    },

    destroy() {
      layer.disable();
      _ground.clear();
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
      if (_zoomIn)
        return {
          info: t('Zoom in to see the remains: they show below {height} km', {
            height: REMAINS_MAX_HEIGHT_M / 1000,
          }),
        };
      const blurb = t(
        'Dots are the remains Riksantikvarieämbetet registers in Fornsök, coloured by their legal assessment; the nearest to the map centre are drawn. Positions can be off by up to 20 m. Click one for its type and number, and click the card to open it at RAÄ.',
      );
      const legend = ASSESSMENTS.map((entry) => ({
        label: t(ASSESSMENT_LABELS[entry.id]),
        color: entry.color,
        count: _shown.filter((row) => row.assessment === entry.id).length,
      }))
        .filter((item) => item.count > 0)
        .map((item, index) => (index === 0 ? { ...item, blurb } : item));
      return {
        legend,
        info:
          _total === null
            ? ''
            : _capped
              ? t('Zoom in to see every remain here.')
              : tn(
                  _total,
                  '{count} remain in view',
                  '{count} remains in view',
                  {
                    count: formatNumber(_total),
                  },
                ),
      };
    },

    /** The shown remain nearest a point within 30 m, or null (tests). */
    remainAt([lon, lat]) {
      return (
        _shown.find(
          ({ point }) =>
            Math.abs(point[0] - lon) < 0.0005 &&
            Math.abs(point[1] - lat) < 0.0003,
        ) ?? null
      );
    },

    getStats() {
      return {
        count: _zoomIn ? null : _total,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
