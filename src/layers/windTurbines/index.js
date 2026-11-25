import { formatNumber, msg, onLocaleChange, t, tn } from '../../i18n/index.js';
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
import { analystRows } from '../analystRows.js';
import {
  TURBINE_KIND,
  TURBINE_KINDS,
  WIND_MAX_HEIGHT_M,
  WIND_SHOWN,
  clipWindBox,
  expandTurbine,
  kindsOf,
} from './records.js';
import {
  TURBINE_KIND_LABELS,
  WIND_TURBINES_OVERLAY_SOURCE_ID,
  buildTurbineCard,
  builtYear,
  formatRegisterDate,
  statusWords,
  turbineName,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createWindTurbinesSource } from './source.js';

export const WIND_TURBINES_LAYER_ID = 'wind-turbines';
const PICK_PREFIX = 'se-wind-turbine:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MOVE_SETTLE_MS = 400;
/** Full rows of clicked turbines kept for their cards. */
const DETAILS_KEPT = 200;
const OUTLINE_COLOR = '#102027';
const SCALE_BY_DISTANCE = Object.freeze({
  near: 2000,
  nearValue: 1.2,
  far: 250_000,
  farValue: 0.6,
});

/** The chips, in order: each adds the kinds of its group. */
const CHIPS = Object.freeze([
  Object.freeze({
    id: 'planned',
    label: msg('PLANNED'),
    title: msg(
      'Show turbines that are planned but not built: permits granted, applications being processed and appealed decisions',
    ),
  }),
  Object.freeze({
    id: 'dismantled',
    label: msg('DISMANTLED'),
    title: msg('Show dismantled turbines'),
  }),
  Object.freeze({
    id: 'rejected',
    label: msg('REJECTED'),
    title: msg(
      'Show turbines whose application was rejected (per Vindbrukskollen)',
    ),
  }),
  Object.freeze({
    id: 'notCurrent',
    label: msg('NOT CURRENT'),
    title: msg(
      'Show turbines that are not current or withdrawn, and those without a status',
    ),
  }),
]);

/** Dot size by total height: a taller turbine reads larger. */
const pixelSize = (row) =>
  !row.totalHeightM
    ? 6
    : row.totalHeightM >= 200
      ? 10
      : row.totalHeightM >= 150
        ? 9
        : row.totalHeightM >= 100
          ? 8
          : 7;

/**
 * Own one display of Sweden's wind turbines: Länsstyrelserna's
 * Vindbrukskollen register, drawn for the view once the camera is low
 * enough, the nearest to the centre first. Built turbines show by default;
 * chips add the planned, dismantled, rejected and no longer current ones.
 * A click gives a turbine's card. The rows come from a snapshot built by hand
 * (scripts/build-wind-turbines.mjs), served per view by /api/wind-turbines.
 * Share links carry it as token 16.
 */
export function createWindTurbinesLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  terrain = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Wind turbines require a snapshot source');
  // With ground heights the dots clamp to terrain only (see groundHeights.js).
  // The rows follow the view, so their heights are kept apart from the fixed
  // layers' and cannot push those out of this browser's store.
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
  let _builtMW = null;
  let _builtPowerUnknown = null;
  let _counts = {};
  let _selectedId = null;
  let _offLocale = null;
  let _turbines = [];
  /** The chips switched on; built turbines always show. */
  const _chipsOn = new Set();
  const _turbineById = new Map();
  /** Full rows read for clicked turbines, by id; oldest first. */
  const _details = new Map();
  let _detailRequest = null;
  /** A turbine as fully as it is known: its full row once read. */
  const fullRow = (row) => (row ? (_details.get(row.id) ?? row) : null);

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(WIND_TURBINES_LAYER_ID);

  /** A turbine's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: pixelSize(row),
    color: TURBINE_KIND[row.kind]?.color ?? TURBINE_KIND.unknown.color,
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? fullRow(_turbineById.get(_selectedId)) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        WIND_TURBINES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildTurbineCard(row, { snapshotAt: _lastUpdate });
    const at = position(row);
    card.position = fromDegrees(at.lon, at.lat, at.height);
    overlayHost.setEntries(
      WIND_TURBINES_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedTurbine(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _turbineById.has(id) ? id : null;
  }

  /**
   * Select a turbine (or none): its card shows at once with what the view
   * carries, and again with every field once its full row is read.
   */
  function select(id) {
    _selectedId = id;
    publishSelectedCard();
    requestRender();
    _detailRequest?.abort();
    _detailRequest = null;
    if (!id || _details.has(id) || typeof source.getTurbine !== 'function')
      return;
    const request = new AbortController();
    _detailRequest = request;
    source
      .getTurbine({ id, signal: request.signal })
      .then((row) => {
        if (request.signal.aborted || row?.id !== id) return;
        _details.set(id, row);
        while (_details.size > DETAILS_KEPT)
          _details.delete(_details.keys().next().value);
        if (_selectedId === id) publishSelectedCard();
        _rowListener?.();
      })
      .catch((e) => {
        if (!request.signal.aborted)
          console.warn('[Data:WindTurbines] Card error:', e?.message || e);
      })
      .finally(() => {
        if (_detailRequest === request) _detailRequest = null;
      });
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      WIND_TURBINES_LAYER_ID,
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
      const hit = pickedTurbine(pickId);
      if (hit) {
        select(hit);
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(WIND_TURBINES_LAYER_ID, pickId))
        return;
      // The bare ground: one card at a time, and none now.
      if (_selectedId) select(null);
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(WIND_TURBINES_LAYER_ID);
  }

  function clearOverlays() {
    _selectedId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(WIND_TURBINES_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(WIND_TURBINES_OVERLAY_SOURCE_ID, false);
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const rows = ids.map((id) => _turbineById.get(id)).filter(Boolean);
    if (!rows.length) return;
    _dots.upsert(rows.map(dotOf));
    if (_selectedId && ids.includes(_selectedId)) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Farthest first, so the nearest draw on top.
    _dots.set([..._turbines].reverse().map(dotOf));
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
    if (!Number.isFinite(height) || height > WIND_MAX_HEIGHT_M) return null;
    const rect = camera.viewRectangle?.();
    if (!rect) return null;
    const center = viewCentre() ?? [pose.lon, pose.lat];
    return {
      // A tilted view reaches the horizon: ask for the part about the centre.
      bbox: clipWindBox([rect.west, rect.south, rect.east, rect.north], center),
      center,
    };
  }

  /** Forget the view's rows: the camera is too high, or the layer off. */
  function clearRows() {
    _zoomIn = true;
    _capped = false;
    _turbines = [];
    _total = null;
    _builtMW = null;
    _builtPowerUnknown = null;
    _counts = {};
    _turbineById.clear();
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
        limit: WIND_SHOWN,
        kinds: kindsOf([..._chipsOn]),
      });
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      _stale = snapshot.stale;
      // The snapshot's date: the rows are as old as that.
      _lastUpdate = Number.isFinite(snapshot.fetchedAt)
        ? snapshot.fetchedAt
        : null;
      _lastError = null;
      _zoomIn = snapshot.tooWide;
      _capped = snapshot.capped;
      _turbines = snapshot.tooWide
        ? []
        : snapshot.turbines.map(expandTurbine).filter(Boolean);
      _total = snapshot.total;
      _builtMW = snapshot.builtMW;
      _builtPowerUnknown = snapshot.builtPowerUnknown;
      _counts = snapshot.counts ?? {};
      _turbineById.clear();
      for (const row of _turbines) _turbineById.set(row.id, row);
      if (_selectedId && !_turbineById.has(_selectedId)) {
        _selectedId = null;
        publishSelectedCard();
      }
      _ground.place(_turbines);
      render();
      _rowListener?.();
      return true;
    } catch (e) {
      if (!_enabled) return false;
      if (request.signal.aborted || _request !== request) return true;
      console.warn('[Data:WindTurbines] Fetch error:', e?.message || e);
      _lastError = e?.message || msg('Wind turbines unavailable');
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

  const turbineLabel = (row) =>
    t('Wind turbine · {name}', { name: turbineName(row) });

  /**
   * The view's count and the rated power of its built turbines. The power is
   * left out while no built turbine with a known power is in view (only
   * planned ones, say), keeps two significant digits under 10 MW (a lone
   * small turbine is 0.04 MW, not 0), and the built turbines the register
   * gives no power for are counted rather than taken as 0 MW.
   * @returns {string[]}
   */
  function viewCountParts() {
    const count = formatNumber(_total ?? 0);
    const parts = [
      _builtMW > 0
        ? t('{count} wind turbines in view · built {power} MW', {
            count,
            power: formatNumber(
              _builtMW,
              _builtMW < 10
                ? { maximumSignificantDigits: 2 }
                : { maximumFractionDigits: 0 },
            ),
          })
        : t('{count} wind turbines in view', { count }),
    ];
    const unknown = _builtPowerUnknown ?? 0;
    if (unknown > 0)
      parts.push(
        tn(
          unknown,
          '{count} built turbine without a stated power',
          '{count} built turbines without a stated power',
          { count: formatNumber(unknown) },
        ),
      );
    return parts;
  }

  const layer = {
    id: WIND_TURBINES_LAYER_ID,
    name: 'Wind turbines (Sweden)',
    icon: '🌬️',
    source: 'Länsstyrelserna',
    updateInterval: 12 * 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Wind turbines layer is already initialized');
      _viewer = viewer;
      _dots = drawOf(viewer).points({
        id: WIND_TURBINES_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
      // An open card follows the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selectedId) publishSelectedCard();
      });
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = true;
      overlayHost?.setVisible?.(WIND_TURBINES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      _removeMove ??=
        (_viewer && findCamera(_viewer)?.on('moveEnd', scheduleRefresh)) ??
        null;
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _detailRequest?.abort();
      _detailRequest = null;
      if (_moveTimer !== null) clearTimeout(_moveTimer);
      _moveTimer = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      _lastError = null;
      if (_dots) _dots.show = false;
      removeClickHandler();
      clearOverlays();
      clearRows();
      render();
    },

    update() {
      return refresh();
    },

    /** Select a shown turbine by its id (tools and tests). */
    setParams(params = {}) {
      if (!_enabled || !params.turbineId) return false;
      const id = String(params.turbineId);
      if (!_turbineById.has(id)) return false;
      select(id);
      return true;
    },

    destroy() {
      _offLocale?.();
      _offLocale = null;
      layer.disable();
      _ground.clear();
      _details.clear();
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
      const chips = CHIPS.map((chip) => ({
        id: chip.id,
        label: t(chip.label),
        active: _chipsOn.has(chip.id),
        title: t(chip.title),
        onClick: () => {
          if (_chipsOn.has(chip.id)) _chipsOn.delete(chip.id);
          else _chipsOn.add(chip.id);
          _rowListener?.();
          void refresh();
        },
      }));
      if (_zoomIn)
        return {
          chips,
          info: t(
            'Zoom in to see the wind turbines: they show below {height} km',
            { height: WIND_MAX_HEIGHT_M / 1000 },
          ),
        };
      const shownKinds = new Set(kindsOf([..._chipsOn]));
      const legend = TURBINE_KINDS.filter((entry) => shownKinds.has(entry.id))
        .map((entry) => ({
          label: t(TURBINE_KIND_LABELS[entry.id]),
          color: entry.color,
          count: _counts[entry.id] ?? 0,
        }))
        .filter((item) => item.count > 0)
        .map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'Dots are the wind turbines in Länsstyrelserna’s Vindbrukskollen register, built ones by default; the chips add planned, dismantled, rejected and no longer current ones. The status is the register’s own. Click a turbine for its card.',
                ),
              }
            : item,
        );
      const snapshot = Number.isFinite(_lastUpdate)
        ? formatRegisterDate(new Date(_lastUpdate).toISOString().slice(0, 10))
        : '';
      const parts = [
        ...(_total === null
          ? []
          : _capped
            ? [t('Zoom in to see every turbine here.')]
            : viewCountParts()),
        snapshot ? t('Snapshot {date}', { date: snapshot }) : '',
      ].filter(Boolean);
      return { chips, legend, info: parts.join(' · ') };
    },

    /** What a picked turbine is called, and where it is. */
    findByQuery(pickId) {
      const id = pickedTurbine(pickId);
      if (!id) return null;
      const row = _turbineById.get(id);
      return {
        name: turbineLabel(row),
        latitude: row.point[1],
        longitude: row.point[0],
      };
    },

    /**
     * The turbines shown, named as findByQuery names them, with the fields
     * the view carries, and every card field of a turbine already clicked.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      return analystRows(_turbines.map(fullRow), maxCount, {
        name: turbineLabel,
        extra: (row) => ({
          turbineStatus: statusWords(row),
          totalHeightM: row.totalHeightM ?? null,
          hubHeightM: row.hubHeightM ?? null,
          rotorDiameterM: row.rotorM ?? null,
          ratedPowerMW: row.powerMW ?? null,
          productionGWhYear: row.productionGWh ?? null,
          turbineModel: [row.make, row.model].filter(Boolean).join(' ') || null,
          builtYear: Number(builtYear(row)) || null,
          municipality: row.municipality ?? null,
          county: row.county ?? null,
          biddingZone: row.zone ?? null,
          turbineOperator: row.operator ?? null,
        }),
      });
    },

    getStats() {
      return {
        count: _zoomIn ? null : (_total ?? 0),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
