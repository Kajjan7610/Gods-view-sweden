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
import { analystRows, yearText } from '../analystRows.js';
import {
  ASSESSMENT,
  ASSESSMENTS,
  PROTECTED_TYPE,
  PROTECTED_TYPES,
  WORLD_HERITAGE_COLOR,
  buildingPage,
  clipRemainsBox,
  remainUrl,
  unescoPage,
} from './records.js';
import {
  ASSESSMENT_LABELS,
  HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
  PROTECTION_LABELS,
  buildBuildingCard,
  buildRemainCard,
  buildWorldSiteCard,
  buildingName,
  remainName,
  worldSiteName,
} from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createHeritageRemainsSource } from './source.js';

export const HERITAGE_REMAINS_LAYER_ID = 'heritage-remains';
/** What a pick id starts with, and the kind of row it picks. */
const PICKS = Object.freeze([
  ['se-remain:', 'remain'],
  ['se-heritage-building:', 'building'],
  ['se-protection-area:', 'area'],
  ['se-world-heritage:', 'world'],
]);
const PICK_PREFIX = Object.freeze(
  Object.fromEntries(PICKS.map(([prefix, kind]) => [kind, prefix])),
);
/**
 * The kinds the row's chips show and hide, all shown at first. Nothing of a
 * kind is read while it is hidden.
 */
export const HERITAGE_KINDS = Object.freeze(['remains', 'world', 'buildings']);
/** The kinds read for the view; the World Heritage list is read whole. */
const VIEW_KINDS = Object.freeze(['remains', 'buildings']);
const KIND_CHIPS = Object.freeze({
  remains: [msg('Remains'), msg('Show or hide the remains')],
  world: [msg('World Heritage'), msg('Show or hide the World Heritage sites')],
  buildings: [
    msg('Protected buildings'),
    msg('Show or hide the protected buildings'),
  ],
});
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
/** The World Heritage list is read again after this long, at most. */
const WORLD_REFRESH_MS = 24 * 60 * 60_000;
/** After a failed World Heritage read, the next waits this long. */
const WORLD_RETRY_MS = 2 * 60_000;
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

/** A ring's edge, closed back to its first point, in ECEF. */
const closedRing = (ring) =>
  [...ring, ring[0]].map(([lon, lat]) => fromDegrees(lon, lat));

/**
 * Own one display of Sweden's cultural heritage: the remains RAÄ registers
 * in Kulturmiljöregistret and the protected buildings of
 * Bebyggelseregistret, drawn for the view once the camera is low enough,
 * the nearest to the centre first, and Sweden's World Heritage sites at
 * every height. Each kind has a chip; a card opens the row at RAÄ or
 * UNESCO. Share links carry it as token 0c.
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
  // Buildings and sites are kept under a prefixed key, remains by their id.
  const _ground = createGroundHeights(terrain, (ids) => lift(ids), {
    passing: true,
  });
  const position = (row, key = row.id) => ({
    lon: row.point[0],
    lat: row.point[1],
    height: _ground.heightOf(key),
  });
  let _viewer = null;
  let _dots = null;
  let _worldLines = null;
  let _areaLines = null;
  // Each view kind's request out, its last error, and when the stale answer
  // it shows was read (null when fresh).
  const _requests = { remains: null, buildings: null };
  const _errors = { remains: null, buildings: null };
  const _staleAt = { remains: null, buildings: null };
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _removeMove = null;
  let _moveTimer = null;
  let _lastUpdate = null;
  let _zoomIn = true;
  let _capped = false;
  let _total = null;
  /** The selected row as `kind:id`, or null. */
  let _selected = null;
  let _offLocale = null;
  let _selectedCardId = null;
  let _shown = [];
  const _byId = new Map();
  const _kinds = new Set(HERITAGE_KINDS);
  // Protected buildings in the view, and the protection areas touching it.
  let _buildings = [];
  let _areas = [];
  let _buildingTotal = null;
  let _buildingCapped = false;
  const _buildingById = new Map();
  const _areaById = new Map();
  // Sweden's World Heritage sites: read once, kept while the app runs.
  let _world = null;
  let _worldAt = 0;
  let _worldFailedAt = 0;
  let _worldError = null;
  let _worldRequest = null;
  let _worldPromise = null;
  const _worldById = new Map();

  const canSelect = () => overlayHost && picking;
  const requestRender = () =>
    _viewer && findFrame(_viewer)?.requestRender(HERITAGE_REMAINS_LAYER_ID);
  const shows = (kind) => _enabled && _kinds.has(kind);

  /** A remain's dot as the set draws it. */
  const dotOf = (row) => ({
    id: `${PICK_PREFIX.remain}${row.id}`,
    pos: position(row),
    height: 'clampGround',
    pixelSize: pixelSize(row),
    color: ASSESSMENT[row.assessment]?.color ?? ASSESSMENT.none.color,
    outlineColor: OUTLINE_COLOR,
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });
  /** A protected building's dot: a little larger, edged in white. */
  const buildingDotOf = (row) => ({
    id: `${PICK_PREFIX.building}${row.id}`,
    pos: position(row, `b:${row.id}`),
    height: 'clampGround',
    pixelSize: 8,
    color: PROTECTED_TYPE[row.protection]?.color ?? PROTECTED_TYPE.bm.color,
    outlineColor: '#ffffff',
    outlineWidth: 1.5,
    disableDepthTest: Number.POSITIVE_INFINITY,
    scaleByDistance: SCALE_BY_DISTANCE,
  });
  /** A World Heritage site's dot, at its largest area's middle. */
  const worldDotOf = (site) => ({
    id: `${PICK_PREFIX.world}${site.id}`,
    pos: position(site, `w:${site.id}`),
    height: 'clampGround',
    pixelSize: 11,
    color: WORLD_HERITAGE_COLOR,
    outlineColor: '#ffffff',
    outlineWidth: 2,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  /** A row by its `kind:id` key, or null. */
  function rowOf(key) {
    if (typeof key !== 'string') return null;
    const at = key.indexOf(':');
    const kind = key.slice(0, at);
    const id = key.slice(at + 1);
    const row =
      kind === 'remain'
        ? _byId.get(id)
        : kind === 'building'
          ? _buildingById.get(id)
          : kind === 'area'
            ? _areaById.get(id)
            : kind === 'world'
              ? _worldById.get(id)
              : null;
    return row ? { kind, row } : null;
  }

  /** The page a selected row opens, or null. */
  function pageOf(selected) {
    if (!selected) return null;
    const { kind, row } = selected;
    if (kind === 'remain') return row.page ? remainUrl(row.page) : null;
    if (kind === 'world') return unescoPage(row.unesco);
    return buildingPage(row.page);
  }

  function openSelected() {
    const url = pageOf(rowOf(_selected));
    if (!url || !openExternal) return false;
    openExternal(url);
    return true;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const selected = rowOf(_selected);
    if (!selected) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const { kind, row } = selected;
    const linkable = Boolean(openExternal && pageOf(selected));
    const card =
      kind === 'remain'
        ? buildRemainCard(row, { linkable })
        : kind === 'world'
          ? buildWorldSiteCard(row, { linkable })
          : buildBuildingCard(row, { linkable, area: kind === 'area' });
    const at = position(
      row,
      kind === 'remain' ? row.id : `${kind === 'world' ? 'w' : 'b'}:${row.id}`,
    );
    card.position = fromDegrees(at.lon, at.lat, at.height);
    if (linkable) card.activate = () => openSelected();
    _selectedCardId = card.id;
    overlayHost.setEntries(
      HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** The `kind:id` key of a picked row of this layer, or null. */
  function pickedRow(pickId) {
    if (typeof pickId !== 'string') return null;
    for (const [prefix, kind] of PICKS) {
      if (!pickId.startsWith(prefix)) continue;
      // Outlines carry their polygon's index after the id.
      const key = `${kind}:${pickId.slice(prefix.length).split(':')[0]}`;
      return rowOf(key) ? key : null;
    }
    return null;
  }

  function select(key) {
    _selected = key;
    publishSelectedCard();
    requestRender();
    _rowListener?.();
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      HERITAGE_REMAINS_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' &&
        PICKS.some(([prefix]) => pickedId.startsWith(prefix)),
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
      // A click on this layer's own card opens the row at RAÄ or UNESCO.
      if (
        cardHit?.sourceId === HERITAGE_REMAINS_OVERLAY_SOURCE_ID &&
        cardHit.entryId === _selectedCardId
      )
        openSelected();
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const hit = pickedRow(pickId);
      if (hit) return select(hit);
      if (
        pickId &&
        picking.isOwnedByOtherLayer(HERITAGE_REMAINS_LAYER_ID, pickId)
      )
        return;
      if (_selected) select(null);
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(HERITAGE_REMAINS_LAYER_ID);
  }

  function clearOverlays() {
    _selected = null;
    _selectedCardId = null;
    if (!overlayHost) return;
    overlayHost.clearSource(HERITAGE_REMAINS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible?.(HERITAGE_REMAINS_OVERLAY_SOURCE_ID, false);
  }

  /** Every shown dot under its ground-height key. */
  function groundRows() {
    return [
      ...(shows('remains') ? _shown : []),
      ...(shows('buildings')
        ? _buildings.map((row) => ({ id: `b:${row.id}`, point: row.point }))
        : []),
      ...(shows('world') && _world
        ? _world.map((site) => ({ id: `w:${site.id}`, point: site.point }))
        : []),
    ];
  }

  /** New ground heights: the dots already drawn move where they are. */
  function lift(ids) {
    if (!_dots) return;
    const dots = [];
    for (const id of ids) {
      if (id.startsWith('b:')) {
        const row = shows('buildings') && _buildingById.get(id.slice(2));
        if (row) dots.push(buildingDotOf(row));
      } else if (id.startsWith('w:')) {
        const site = shows('world') && _worldById.get(id.slice(2));
        if (site) dots.push(worldDotOf(site));
      } else {
        const row = shows('remains') && _byId.get(id);
        if (row) dots.push(dotOf(row));
      }
    }
    if (!dots.length) return;
    _dots.upsert(dots);
    if (_selected) publishSelectedCard();
    requestRender();
  }

  function render() {
    if (!_dots) return;
    // Farthest first, so the nearest draw on top where dots meet; buildings
    // over remains, and the World Heritage sites over both.
    _dots.set([
      ...(shows('remains') ? [..._shown].reverse().map(dotOf) : []),
      ...(shows('buildings')
        ? [..._buildings].reverse().map(buildingDotOf)
        : []),
      ...(shows('world') && _world ? _world.map(worldDotOf) : []),
    ]);
    if (_selected) publishSelectedCard();
    requestRender();
  }

  /** The protection areas' outlines, drawn again with each view. */
  function drawAreas() {
    if (!_areaLines) return;
    const lines = [];
    if (shows('buildings'))
      for (const area of _areas)
        area.rings.forEach((ring, index) =>
          lines.push({
            id: `${PICK_PREFIX.area}${area.id}:${index}`,
            positions: closedRing(ring),
            widthPx: 2,
            mode: 'draped',
            style: {
              kind: 'solid',
              color:
                PROTECTED_TYPE[area.protection]?.color ??
                PROTECTED_TYPE.bm.color,
            },
          }),
        );
    _areaLines.set(lines);
    _areaLines.show = _enabled;
  }

  /** The World Heritage outlines: drawn only when the list or kind changes. */
  function drawWorld() {
    if (!_worldLines) return;
    const lines = [];
    if (shows('world') && _world)
      for (const site of _world)
        site.rings.forEach((ring, index) =>
          lines.push({
            id: `${PICK_PREFIX.world}${site.id}:${index}`,
            positions: closedRing(ring),
            widthPx: 2.5,
            mode: 'draped',
            style: { kind: 'solid', color: WORLD_HERITAGE_COLOR },
          }),
        );
    _worldLines.set(lines);
    _worldLines.show = _enabled;
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

  /** Forget the view's remains: the camera is too high, or the kind off. */
  function clearRemains() {
    _capped = false;
    _shown = [];
    _total = null;
    _byId.clear();
  }

  /** Forget the view's protected buildings. */
  function clearBuildings() {
    _buildings = [];
    _areas = [];
    _buildingTotal = null;
    _buildingCapped = false;
    _buildingById.clear();
    _areaById.clear();
  }

  /** Forget the view: the camera is too high, or the layer off. */
  function clearRows() {
    _zoomIn = true;
    clearRemains();
    clearBuildings();
    _ground.cancel();
  }

  /** The selection, dropped when its row left. */
  function keepSelection() {
    if (_selected && !rowOf(_selected)) {
      _selected = null;
      publishSelectedCard();
    }
  }

  /** Show the view's rows: ground heights, dots, outlines and the row. */
  function show() {
    keepSelection();
    void _ground.place(groundRows());
    render();
    drawAreas();
    _rowListener?.();
  }

  /**
   * Read the World Heritage list when the kind is shown and the list is
   * missing or a day old; a failure waits a while. Not aborted by camera
   * moves: it is not about the view.
   */
  function loadWorld() {
    if (_worldPromise) return _worldPromise;
    if (
      !shows('world') ||
      typeof source.getWorldHeritage !== 'function' ||
      (_world && Date.now() - _worldAt < WORLD_REFRESH_MS) ||
      (_worldFailedAt && Date.now() - _worldFailedAt < WORLD_RETRY_MS)
    )
      return null;
    const request = new AbortController();
    _worldRequest = request;
    _worldPromise = source
      .getWorldHeritage({ signal: request.signal })
      .then(
        (snapshot) => {
          if (_worldRequest !== request || !_enabled) return;
          _world = snapshot.sites;
          _worldAt = Date.now();
          _worldFailedAt = 0;
          _worldError = null;
          _worldById.clear();
          for (const site of _world) _worldById.set(site.id, site);
          void _ground.place(groundRows());
          render();
          drawWorld();
          _rowListener?.();
        },
        (e) => {
          if (_worldRequest !== request || !_enabled) return;
          console.warn(
            '[Data:HeritageRemains] World Heritage:',
            e?.message || e,
          );
          _worldFailedAt = Date.now();
          _worldError = e?.message || msg('World Heritage unavailable');
          _rowListener?.();
        },
      )
      .finally(() => {
        if (_worldRequest === request) {
          _worldRequest = null;
          _worldPromise = null;
        }
      });
    return _worldPromise;
  }

  /** Whether a view kind is shown and its source can read it. */
  const wants = (kind) =>
    _kinds.has(kind) &&
    (kind === 'remains' || typeof source.getBuildings === 'function');

  /**
   * Read one view kind, its own request: a newer read of the same kind
   * supersedes it (null), and the other kind's is left alone.
   */
  async function readKind(kind, query) {
    _requests[kind]?.abort();
    const request = new AbortController();
    _requests[kind] = request;
    const read = kind === 'remains' ? source.getSnapshot : source.getBuildings;
    try {
      const snapshot = await read.call(source, {
        signal: request.signal,
        ...query,
        limit: SHOWN,
      });
      if (request.signal.aborted || _requests[kind] !== request) return null;
      return { kind, snapshot };
    } catch (error) {
      if (request.signal.aborted || _requests[kind] !== request) return null;
      return { kind, error };
    } finally {
      if (_requests[kind] === request) _requests[kind] = null;
    }
  }

  /** Keep one kind's answer for the view. */
  function apply({ kind, snapshot, error }) {
    if (error) {
      console.warn(
        kind === 'remains'
          ? '[Data:HeritageRemains] Fetch error:'
          : '[Data:HeritageRemains] Buildings:',
        error?.message || error,
      );
      _errors[kind] =
        error?.message ||
        (kind === 'remains'
          ? msg('Heritage remains unavailable')
          : msg('Protected buildings unavailable'));
      _staleAt[kind] = null;
      return;
    }
    _errors[kind] = null;
    _staleAt[kind] = snapshot.stale
      ? Number.isFinite(snapshot.fetchedAt)
        ? snapshot.fetchedAt
        : Date.now()
      : null;
    _lastUpdate = _staleAt[kind] ?? Date.now();
    _zoomIn = snapshot.tooWide;
    if (kind === 'remains') {
      _capped = snapshot.capped;
      _shown = snapshot.tooWide ? [] : snapshot.remains;
      _total = snapshot.total;
      _byId.clear();
      for (const row of _shown) _byId.set(row.id, row);
      return;
    }
    _buildingCapped = snapshot.capped;
    _buildings = snapshot.tooWide ? [] : snapshot.buildings;
    _areas = snapshot.tooWide ? [] : snapshot.areas;
    _buildingTotal = snapshot.total;
    _buildingById.clear();
    _areaById.clear();
    for (const row of _buildings) _buildingById.set(row.id, row);
    for (const row of _areas) _areaById.set(row.id, row);
  }

  /**
   * Read the view: remains and protected buildings, one request each, and
   * the World Heritage list when it is due. `only` reads one kind (a chip
   * turned on) and leaves the other's view as it is.
   */
  async function refresh(only = null) {
    if (!_enabled || !_dots) return false;
    const world = loadWorld();
    const query = viewQuery();
    for (const kind of VIEW_KINDS)
      if (!wants(kind)) {
        _requests[kind]?.abort();
        _requests[kind] = null;
        _errors[kind] = null;
        _staleAt[kind] = null;
        if (kind === 'remains') clearRemains();
        else clearBuildings();
      }
    const kinds = VIEW_KINDS.filter(
      (kind) => wants(kind) && (!only || only === kind),
    );
    if (!query || !kinds.length) {
      if (!query) {
        for (const kind of VIEW_KINDS) _requests[kind]?.abort();
        clearRows();
      } else if (!VIEW_KINDS.some(wants)) _zoomIn = false;
      show();
      await world;
      return true;
    }
    const results = await Promise.all(
      kinds.map((kind) => readKind(kind, query)),
    );
    if (!_enabled) return false;
    const fresh = results.filter((result) => result && wants(result.kind));
    if (!fresh.length) return true;
    for (const result of fresh) apply(result);
    show();
    await world;
    return true;
  }

  function scheduleRefresh() {
    if (_moveTimer !== null) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      _moveTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
  }

  /** Show or hide a kind; one shown again is read at once. */
  function toggleKind(kind) {
    if (_kinds.has(kind)) {
      _kinds.delete(kind);
      if (VIEW_KINDS.includes(kind)) {
        _requests[kind]?.abort();
        _requests[kind] = null;
        _errors[kind] = null;
        _staleAt[kind] = null;
        if (kind === 'remains') clearRemains();
        else clearBuildings();
      } else {
        _worldRequest?.abort();
        _worldRequest = null;
        _worldPromise = null;
      }
      keepSelection();
      if (kind === 'world' && _selected?.startsWith('world:')) select(null);
      void _ground.place(groundRows());
      render();
      drawAreas();
      drawWorld();
      _rowListener?.();
      return;
    }
    _kinds.add(kind);
    _rowListener?.();
    if (kind !== 'world') return void refresh(kind);
    // The list read before shows again at once; a missing one is read.
    void _ground.place(groundRows());
    render();
    drawWorld();
    if (_enabled) void loadWorld();
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
      const draw = drawOf(viewer);
      _dots = draw.points({
        id: HERITAGE_REMAINS_LAYER_ID,
        // Terrain only once the dots have their ground heights: clamping
        // thousands of dots to 3D tiles freezes the app (groundHeights.js).
        clampTo: _ground.enabled ? 'terrain' : 'both',
        horizonCull: true,
        show: false,
      });
      _areaLines = draw.lines({
        id: `${HERITAGE_REMAINS_LAYER_ID}:protection-areas`,
        clampTo: 'both',
        show: false,
      });
      _worldLines = draw.lines({
        id: `${HERITAGE_REMAINS_LAYER_ID}:world-heritage`,
        clampTo: 'both',
        show: false,
      });
      // An open card follows the reader's language.
      _offLocale = onLocaleChange(() => {
        if (_selected) publishSelectedCard();
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
      // The sites read before the layer went off show again at once.
      render();
      drawWorld();
      requestRender();
    },

    disable() {
      for (const kind of VIEW_KINDS) {
        _requests[kind]?.abort();
        _requests[kind] = null;
      }
      _worldRequest?.abort();
      _worldRequest = null;
      _worldPromise = null;
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
      drawAreas();
      drawWorld();
    },

    update() {
      return refresh();
    },

    /**
     * Select a row in the view by its id (tools and tests): `remainId`,
     * `buildingId` or `worldSiteId`.
     */
    setParams(params = {}) {
      if (!_enabled) return false;
      const key = params.remainId
        ? `remain:${params.remainId}`
        : params.buildingId
          ? `building:${params.buildingId}`
          : params.worldSiteId
            ? `world:${params.worldSiteId}`
            : null;
      if (!key || !rowOf(String(key))) return false;
      _selected = String(key);
      publishSelectedCard();
      _rowListener?.();
      return true;
    },

    destroy() {
      _offLocale?.();
      _offLocale = null;
      layer.disable();
      _ground.clear();
      _dots?.dispose();
      _areaLines?.dispose();
      _worldLines?.dispose();
      _dots = null;
      _areaLines = null;
      _worldLines = null;
      _viewer = null;
      _lastUpdate = null;
      for (const kind of VIEW_KINDS) {
        _errors[kind] = null;
        _staleAt[kind] = null;
      }
      _worldError = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const chips = HERITAGE_KINDS.map((kind) => ({
        id: `kind-${kind}`,
        label: t(KIND_CHIPS[kind][0]),
        active: _kinds.has(kind),
        title: t(KIND_CHIPS[kind][1]),
        onClick: () => toggleKind(kind),
      }));
      const legend = [];
      if (_kinds.has('remains') && !_zoomIn) {
        const blurb = t(
          'Dots are the remains Riksantikvarieämbetet registers in Fornsök, coloured by their legal assessment; the nearest to the map centre are drawn. Positions can be off by up to 20 m. Click one for its type and number, and click the card to open it at RAÄ.',
        );
        ASSESSMENTS.map((entry) => ({
          label: t(ASSESSMENT_LABELS[entry.id]),
          color: entry.color,
          count: _shown.filter((row) => row.assessment === entry.id).length,
        }))
          .filter((item) => item.count > 0)
          .forEach((item, index) =>
            legend.push(index === 0 ? { ...item, blurb } : item),
          );
      }
      if (_kinds.has('buildings') && !_zoomIn) {
        const blurb = t(
          'Dots are the buildings under legal protection in Riksantikvarieämbetet’s Bebyggelseregistret: listed buildings, state listed buildings and protected church heritage; lines are the protection areas of listed buildings. Other inventoried buildings, mostly private homes, are never shown. Click one for its protection, years and purpose, and click the card to open it at RAÄ.',
        );
        PROTECTED_TYPES.map((entry) => ({
          label: t(PROTECTION_LABELS[entry.id]),
          color: entry.color,
          count: _buildings.filter((row) => row.protection === entry.id).length,
          areas: _areas.some((row) => row.protection === entry.id),
        }))
          .filter((item) => item.count > 0 || item.areas)
          .forEach(({ areas: _a, ...item }, index) =>
            legend.push(index === 0 ? { ...item, blurb } : item),
          );
      }
      if (_kinds.has('world') && _world?.length)
        legend.push({
          label: t('World Heritage'),
          color: WORLD_HERITAGE_COLOR,
          count: _world.length,
          blurb: t(
            'Blue dots and outlines are Sweden’s UNESCO World Heritage sites as Riksantikvarieämbetet maps them, shown at every height. Buffer zones are not included, and Struve’s arc is drawn schematically. Click one for its year of inscription, and click the card to open it at UNESCO.',
          ),
        });
      const info = [];
      if (_zoomIn) {
        if (_kinds.has('remains') && _kinds.has('buildings'))
          info.push(
            t(
              'Zoom in to see the remains and protected buildings: they show below {height} km',
              { height: REMAINS_MAX_HEIGHT_M / 1000 },
            ),
          );
        else if (_kinds.has('remains'))
          info.push(
            t('Zoom in to see the remains: they show below {height} km', {
              height: REMAINS_MAX_HEIGHT_M / 1000,
            }),
          );
        else if (_kinds.has('buildings'))
          info.push(
            t(
              'Zoom in to see the protected buildings: they show below {height} km',
              { height: REMAINS_MAX_HEIGHT_M / 1000 },
            ),
          );
      } else {
        if (_kinds.has('remains') && _total !== null)
          info.push(
            _capped
              ? t('Zoom in to see every remain here.')
              : tn(
                  _total,
                  '{count} remain in view',
                  '{count} remains in view',
                  {
                    count: formatNumber(_total),
                  },
                ),
          );
        if (_kinds.has('buildings') && _buildingTotal !== null)
          info.push(
            _buildingCapped
              ? t('Zoom in to see every protected building here.')
              : tn(
                  _buildingTotal,
                  '{count} protected building in view',
                  '{count} protected buildings in view',
                  { count: formatNumber(_buildingTotal) },
                ),
          );
      }
      return { chips, legend, info: info.join(' · ') };
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

    /** What a picked remain, building, area or site is called, and where. */
    findByQuery(pickId) {
      const hit = rowOf(pickedRow(pickId));
      if (!hit) return null;
      const { kind, row } = hit;
      return {
        name:
          kind === 'remain'
            ? remainName(row)
            : kind === 'world'
              ? worldSiteName(row)
              : buildingName(row),
        latitude: row.point[1],
        longitude: row.point[0],
      };
    },

    /**
     * The shown remains, protected buildings and areas, and World Heritage
     * sites, as the analyst reads them, named as on the card.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const remains = analystRows(
        _kinds.has('remains') ? _shown : [],
        maxCount,
        {
          name: remainName,
          extra: (row) => ({
            type: row.type ?? null,
            assessment: t(
              ASSESSMENT_LABELS[row.assessment] ?? ASSESSMENT_LABELS.none,
            ),
            number: row.number || row.raa || null,
            municipality: row.municipality ?? null,
            confirmed: Boolean(row.confirmed),
          }),
        },
      );
      const buildings = analystRows(
        _kinds.has('buildings') ? [..._buildings, ..._areas] : [],
        maxCount,
        {
          name: buildingName,
          extra: (row) => ({
            protection: t(
              PROTECTION_LABELS[row.protection] ?? PROTECTION_LABELS.bm,
            ),
            decided: yearText(row.decided),
            built: row.built
              ? row.built.from === row.built.to
                ? String(row.built.from)
                : `${row.built.from}–${row.built.to}`
              : null,
            purpose: row.purpose ?? null,
            municipality: row.municipality ?? null,
          }),
        },
      );
      const sites = analystRows(
        _kinds.has('world') && _world ? _world : [],
        maxCount,
        {
          name: (site) => worldSiteName(site),
          extra: (site) => ({
            worldHeritage: true,
            inscribed: yearText(site.inscribed),
          }),
        },
      );
      return [...remains, ...buildings, ...sites].slice(
        0,
        Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000,
      );
    },

    getStats() {
      const counts = [
        ...(_kinds.has('remains') && !_zoomIn && _total !== null
          ? [_total]
          : []),
        ...(_kinds.has('buildings') && !_zoomIn && _buildingTotal !== null
          ? [_buildingTotal]
          : []),
        ...(_kinds.has('world') && _world ? [_world.length] : []),
      ];
      return {
        count: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
        lastUpdate: _lastUpdate,
        error:
          _errors.remains ??
          _errors.buildings ??
          (_kinds.has('world') ? _worldError : null),
        stale: VIEW_KINDS.some((kind) => _staleAt[kind] !== null),
      };
    },
  };
  return layer;
}
