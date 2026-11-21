import { msg, onLocaleChange, t } from '../../i18n/index.js';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../../maps/imageryHost.js';
import {
  canvasOf,
  findCamera,
  findGlobe,
  rendererOf,
} from '../../render/rendererOf.js';
import {
  DEFAULT_SELECTION,
  HISTORICAL_ORTHO_CATALOGUE,
  HISTORICAL_ORTHO_LAYER_ID,
  HISTORICAL_ORTHO_MAX_HEIGHT_M,
  HISTORICAL_ORTHO_TILESET_MAX_HEIGHT_M,
  HISTORICAL_ORTHO_TILESET_MAX_PITCH,
  HISTORICAL_ORTHO_VARIANTS,
  VARIANT_WORDS,
  catalogueYear,
  drapedLayers,
  hasFlightYears,
  hasVariant,
  normalizeSelection,
  selectedPhoto,
  viewTouchesSweden,
} from './model.js';
import { COMPARISON_IN_USE, createComparisonLease } from './comparisonLease.js';
export * from './model.js';
export * from './comparisonLease.js';
export { createHistoricalOrthoSource } from './source.js';
export { createHistoricalOrthoRenderer } from './rendering.js';

const ZOOM_IN = msg('Zoom in to see the aerial photos');
const NO_LOGIN = msg('Geotorget account needed');
const NO_LOGIN_INFO = msg(
  'Needs a free Geotorget account at Lantmäteriet — add it in Provider Settings',
);
const LOGIN_REFUSED = msg('Lantmäteriet refused the Geotorget login');
const LOGIN_REFUSED_INFO = msg(
  'Lantmäteriet refused the Geotorget login — check the username and password in Provider Settings',
);
/** The Provider Settings entry the login is saved under (keySetupCore). */
const KEY_ID = 'geotorget';
const STATUS_UNAVAILABLE = msg('Historical aerial photos unavailable');
const TILES_FAILING = msg('Lantmäteriet’s photos are not loading');
const BUDGET_SPENT = msg(
  'Today’s budget of new photos from Lantmäteriet is spent; photos already fetched still show',
);
const DRAW_FAILED = msg('Lantmäteriet’s photos could not be drawn');
const OUTSIDE = msg('Outside Sweden: Lantmäteriet’s photos show only Sweden');
// HISTORICAL_ORTHO_TILESET_MAX_HEIGHT_M and _MAX_PITCH, in words.
const TILESET_ZOOM = msg(
  'On Google 3D the photos show only below 25 km, looking down',
);
const OVER_3D = msg('The old photo lies over today’s 3D buildings');
const WAITING_FOR_ESRI = msg('Switching to the Esri map for the photos…');
// THEN | NOW: Recent Imagery's wording for a swipe off the globe.
const SWIPE_NEEDS_GLOBE = msg('Swipe needs a globe map');
/** Map stacks whose imagery is a mosaic of several dates. */
const MOSAIC_STACK_KINDS = new Set(['esri-imagery', 'ion']);
const DEFAULT_SPLIT = 0.5;
/** Failed tiles (other than "outside Sweden") before the row says so. */
const TILE_ERROR_LIMIT = 4;
/** HTTP statuses of tiles that are no fault: a bad or outside tile. */
const NO_FAULT = new Set([400, 404]);

/** A year's chip title. */
function yearTitle(entry) {
  return entry.reference
    ? t(
        'Reference year {year}: Lantmäteriet’s black-and-white mosaic, 0.5 m, flown over several years',
        { year: entry.year },
      )
    : t(
        '{year}: black and white, 1 m, only the parts of Sweden flown that year',
        { year: entry.year },
      );
}

/** The renderer's capabilities, or null for a viewer with none bound. */
const capabilitiesOfViewer = (viewer) =>
  (viewer && rendererOf(viewer)?.capabilities) || null;

/**
 * Own one display of Lantmäteriet's historical orthophotos ("Då och nu"):
 * the photo of one year, draped on the map, black and white by default,
 * in colour or infrared where that year has them, and for the reference
 * years 1960 and 1975 the sheets with the year each was mostly flown and
 * the seams between the photos. The tiles come from the app's own proxy,
 * which holds the owner's Geotorget login; the layer reads the proxy's
 * status once when switched on and drapes nothing without a working login.
 *
 * The photos drape on the globe. On Google 3D the layer takes the imagery
 * comparison lease (`comparisonLease.js`), which moves the map to Esri
 * while the photos are on and back when they go. Only when the lease
 * cannot be had do they drape on the 3D tiles, and then only from low and
 * looking down, with a note that the old photo lies over today's
 * buildings: the 3D tiles are not hidden by level, and a far view would
 * ask for hundreds of tiles.
 *
 * Nothing is asked for above HISTORICAL_ORTHO_MAX_HEIGHT_M, outside
 * Sweden's box or coarser than the minimum level, and the imagery layers
 * go when the layer is switched off. Share links carry it as token 17; the
 * year and variant are this session's choice.
 *
 * THEN | NOW puts a divider across the map (`createSplit`, the app's
 * imagery split, over the globe port's split): the historical photo, and
 * the sheets when FLIGHT YEARS is on, left of it, today's map right. It
 * works only on the globe; hidden, not torn down, while the photos are not
 * shown, and torn down when switched off or with the layer.
 * @param {{ source: { getStatus: Function, getTileTemplate: Function }, renderer: object, host?: Function, globeOf?: Function, cameraOf?: Function, capabilitiesOf?: Function, createSplit?: Function | null, splitTarget?: Function | null, requestRender?: (reason: string) => void }} options
 */
export function createHistoricalOrthoLayer({
  source,
  renderer,
  host = resolveImageryHost,
  globeOf = findGlobe,
  cameraOf = findCamera,
  capabilitiesOf = capabilitiesOfViewer,
  // The divider (src/ui/imagerySplit.js) and the split it moves; without
  // them the row offers no THEN | NOW.
  createSplit = null,
  splitTarget = null,
  requestRender = () => {},
} = {}) {
  if (typeof source?.getStatus !== 'function')
    throw new TypeError('Historical aerial photos need a status source');
  if (typeof renderer?.show !== 'function')
    throw new TypeError('Historical aerial photos need a renderer');
  let _viewer = null;
  let _tileset = null;
  let _unsubscribeMap = null;
  let _removeMove = null;
  let _enabled = false;
  let _destroyed = false;
  let _rowListener = null;
  let _selection = DEFAULT_SELECTION;
  /** The proxy's answer since the layer was switched on, or null. */
  let _status = null;
  let _statusError = null;
  let _statusRequest = null;
  let _lastUpdate = null;
  /** The camera as last read: height, pitch, view rectangle, point. */
  let _view = null;
  /** Why nothing is draped now (`hidden()`), or null while draped. */
  let _reason = 'off';
  let _hostInfo = { collection: null, kind: 'none' };
  let _tileErrors = 0;
  let _budgetSpent = false;
  /** The one status re-read failing tiles may ask for until tiles load. */
  let _rechecked = false;
  let _mapStack = null;
  /** THEN | NOW is wanted, and where its divider stands (0–1). */
  let _swipe = false;
  let _splitValue = DEFAULT_SPLIT;
  /** The live divider, and the labels it was made with. */
  let _split = null;
  let _splitSignature = '';
  /** The globe port the divider moves: a new port gets a new divider. */
  let _splitGlobe = null;

  const notify = () => _rowListener?.();
  const loginWorks = () =>
    Boolean(_status?.hasLogin) && _status.authFailed !== true;
  /** Whether the renderer has a capability (a viewer with none: yes). */
  const can = (capability) => {
    const capabilities = capabilitiesOf(_viewer);
    return capabilities ? capabilities.has(capability) : true;
  };

  const lease = createComparisonLease({
    owner: HISTORICAL_ORTHO_LAYER_ID,
    label: 'HistoricalOrtho', // i18n-ignore: console log tag
    isLive: () => !_destroyed,
    // A settled lease moves the map; the switch's own notice moves the
    // host, and this redraws for the lease's state.
    onChange: () => {
      if (_enabled) {
        syncHost();
        sync();
      }
      notify();
    },
  });

  function readView() {
    const camera = _viewer ? cameraOf(_viewer) : null;
    const pose = camera?.pose?.() ?? null;
    let rect = null;
    try {
      rect = camera?.viewRectangle?.() ?? null;
    } catch {
      rect = null;
    }
    return {
      height: pose?.height,
      pitch: pose?.pitch,
      lon: pose?.lon,
      lat: pose?.lat,
      rect,
    };
  }

  function syncHost() {
    const next = host({ viewer: _viewer, tileset: _tileset }) || {
      collection: null,
      kind: 'none',
    };
    const changed =
      next.collection !== _hostInfo.collection || next.kind !== _hostInfo.kind;
    _hostInfo = next;
    // The layers drape through the viewer's globe port, on the tileset too
    // when that is the host.
    renderer.rebind({
      ...next,
      globe: next.kind === 'none' ? null : globeOf(_viewer),
      tileset: next.kind === 'tileset' ? _tileset : null,
      imageHooks: can('imageHooks'),
    });
    return changed;
  }

  /** Whether the photos would lie on Google's 3D tiles. */
  const onTiles = () => _hostInfo.kind === 'tileset';

  /**
   * Why the photos are not draped though the login works, or null:
   * `host` (nowhere to drape), `lease` (the map is moving to Esri),
   * `outside` (the view is off Sweden), `zoom` (too high for the globe)
   * or `tileset-zoom` (too high or too tilted for the 3D tiles).
   */
  function hidden() {
    if (_hostInfo.kind === 'none') return 'host';
    if (onTiles()) {
      if (!can('imageryOnTiles')) return 'host';
      const state = lease.status();
      if (state === 'acquiring' || state === 'releasing') return 'lease';
    }
    const view = _view ?? readView();
    if (!viewTouchesSweden(view.rect, view)) return 'outside';
    const height = view.height;
    if (onTiles())
      return Number.isFinite(height) &&
        height <= HISTORICAL_ORTHO_TILESET_MAX_HEIGHT_M &&
        Number.isFinite(view.pitch) &&
        view.pitch <= HISTORICAL_ORTHO_TILESET_MAX_PITCH
        ? null
        : 'tileset-zoom';
    return Number.isFinite(height) && height <= HISTORICAL_ORTHO_MAX_HEIGHT_M
      ? null
      : 'zoom';
  }

  /**
   * Hold the lease while the photos are wanted (on, with a working login)
   * and drape them when everything allows it; else nothing.
   */
  function sync() {
    const wanted = _enabled && loginWorks();
    if (wanted) lease.acquire();
    else if (lease.held()) lease.release();
    _reason = wanted ? hidden() : 'off';
    if (_reason === null) renderer.show(drapedLayers(_selection));
    else renderer.hide();
    syncSwipe();
  }

  const swipeOffered = () =>
    typeof createSplit === 'function' && typeof splitTarget === 'function';

  /**
   * Why the divider cannot work now, or null when it can: `loading` (no
   * status yet), `login` (none, or refused), `wait` (the lease is being
   * taken or given back), `refused` (another scene holds the lease, or
   * Esri failed) or `globe` (not on the globe). The globe's split is the
   * lease holder's: as for Recent Imagery's swipe, only a lease that is
   * ready, or a map with no lease to take, grants it.
   */
  function swipeBlock() {
    if (!_enabled || !_status) return 'loading';
    if (!loginWorks()) return 'login';
    const state = lease.status();
    if (state === 'unavailable') return 'refused';
    if (state !== 'ready' && state !== 'unsupported') return 'wait';
    if (_hostInfo.kind !== 'globe' || !can('splitSwipe')) return 'globe';
    if (!splitTarget(globeOf(_viewer))) return 'globe';
    return null;
  }

  /** The globe port's split, when the divider can work; else null. */
  function swipeTarget() {
    if (!swipeOffered() || swipeBlock()) return null;
    return splitTarget(globeOf(_viewer)) ?? null;
  }

  /** The chip's title: what it does, or why it cannot. */
  function swipeTitle(block) {
    switch (block) {
      case null:
        return t(
          'A divider across the map: the historical photo on the left, today’s map on the right',
        );
      case 'loading':
        return t('Checking the Geotorget login…');
      case 'login':
        return t(_status?.authFailed ? LOGIN_REFUSED : NO_LOGIN);
      case 'wait':
        return t(WAITING_FOR_ESRI);
      case 'refused':
        return t(lease.error() || COMPARISON_IN_USE);
      default:
        return t(SWIPE_NEEDS_GLOBE);
    }
  }

  /** The left side's label: the year, and the variant unless black and white. */
  function thenLabel() {
    const { year, variant } = _selection;
    return variant === 'bw'
      ? String(year)
      : t('{year} {variant}', { year, variant: t(VARIANT_WORDS[variant]) });
  }

  /** Today's map by its name, where the map stack gives one. */
  function nowSide() {
    const stack = _mapStack?.getActiveStack?.() ?? null;
    const name = typeof stack?.label === 'string' ? stack.label : '';
    if (!name) return { label: t('Today’s map'), title: t('Today’s map') };
    return {
      label: t('Today · {map}', { map: name }),
      title: MOSAIC_STACK_KINDS.has(stack.kind)
        ? t('Today: {map}, dates vary', { map: name })
        : t('Today: {map}', { map: name }),
    };
  }

  function destroySplit() {
    _split?.destroy();
    _split = null;
    _splitSignature = '';
    _splitGlobe = null;
  }

  /**
   * The divider follows the photos: made (or remade, keeping its value,
   * when a label changes) while THEN | NOW is on over the globe, shown
   * while the photos are, hidden otherwise; the layers draw left of it
   * only while it shows.
   */
  function syncSwipe() {
    const block = swipeOffered() ? swipeBlock() : 'offered';
    const target = _enabled && _swipe && !block ? swipeTarget() : null;
    if (!target) {
      renderer.setSplit?.('none');
      // Off the globe the lease is still ours, so the divider only hides;
      // otherwise the split is not ours to hold (or nothing is shown).
      if (_enabled && _swipe && block === 'globe') _split?.setVisible(false);
      else destroySplit();
      return;
    }
    const globe = globeOf(_viewer);
    const then = thenLabel();
    const now = nowSide();
    const signature = `${then}|${now.label}|${now.title}`;
    if (_split && (signature !== _splitSignature || globe !== _splitGlobe))
      destroySplit();
    if (!_split) {
      _splitGlobe = globe;
      _split = createSplit({
        scene: target,
        initialValue: _splitValue,
        id: 'historical-ortho-split-line',
        handleClass: 'historical-ortho-split-handle',
        cssProperty: '--historical-ortho-split',
        beforeLabel: then,
        afterLabel: now.label,
        beforeTitle: () =>
          t('Lantmäteriet’s historical photo, {then}', { then: thenLabel() }),
        afterTitle: () => nowSide().title,
        ariaLabel: () => t('Then and now divider'),
        formatValueText: (left, right) =>
          t('Then {left} percent, now {right} percent', { left, right }),
        getViewportWidth: () =>
          Number(canvasOf(_viewer)?.clientWidth) ||
          Number(globalThis.document?.documentElement?.clientWidth) ||
          0,
        onChange: (value) => {
          _splitValue = value;
        },
        requestRender: () => requestRender('historical-ortho-split'),
      });
      _splitSignature = signature;
    }
    const showing = _reason === null;
    _split?.setVisible(showing);
    renderer.setSplit?.(showing ? 'left' : 'none');
  }

  /** Switch THEN | NOW, or move its divider. */
  function chooseSwipe({ swipe, split }) {
    let changed = false;
    if (typeof split === 'number' && split !== _splitValue) {
      _splitValue = split;
      // The divider asks for its own frame when its value moves.
      _split?.setValue(split);
      changed = true;
    }
    if (typeof swipe === 'boolean' && swipe !== _swipe) {
      _swipe = swipe;
      changed = true;
      syncSwipe();
    }
    if (changed) notify();
    return changed;
  }

  async function readStatus() {
    _statusRequest?.abort();
    const request = new AbortController();
    _statusRequest = request;
    try {
      const status = await source.getStatus({ signal: request.signal });
      if (!_enabled || request.signal.aborted) return;
      _status = status;
      _statusError = null;
      _lastUpdate = Date.now();
      // All is well again: earlier failures no longer stand.
      if (loginWorks()) {
        _tileErrors = 0;
        _budgetSpent = false;
      }
    } catch (error) {
      if (!_enabled || request.signal.aborted) return;
      console.warn(
        '[Data:HistoricalOrtho] Status error:',
        error?.message || error,
      );
      _statusError = STATUS_UNAVAILABLE;
    } finally {
      if (_statusRequest === request) _statusRequest = null;
    }
    sync();
    notify();
  }

  /**
   * A tile the proxy refused. A bad or outside tile is no fault; a spent
   * budget is said on the row; other failures are counted, and the first
   * few make the layer read the status once more, which tells a refused
   * login (the proxy learns it from the first tiles) from a passing fault.
   */
  function tileFailed(error) {
    if (!_enabled) return;
    const status = error?.status;
    if (NO_FAULT.has(status)) return;
    if (status === 429) {
      if (!_budgetSpent) {
        _budgetSpent = true;
        notify();
      }
      return;
    }
    _tileErrors += 1;
    if (_tileErrors === TILE_ERROR_LIMIT) {
      notify();
      if (!_rechecked) {
        _rechecked = true;
        void readStatus();
      }
    }
  }

  /** A tile loaded: earlier failures no longer stand. */
  function tileLoaded() {
    if (!_enabled || (_tileErrors === 0 && !_budgetSpent)) return;
    _tileErrors = 0;
    _budgetSpent = false;
    _rechecked = false;
    notify();
  }

  // The divider's labels are worded when it is made: a new language
  // rebuilds it (`syncSwipe` compares them).
  const _offLocale = onLocaleChange(() => {
    if (_enabled) syncSwipe();
  });

  renderer.setTileErrorListener?.(tileFailed);
  renderer.setTileLoadListener?.(tileLoaded);

  function onMove() {
    if (!_enabled) return;
    _view = readView();
    const before = _reason;
    sync();
    if (_reason !== before) notify();
  }

  /** A settled stack switch (or, without a subscription, the stats poll). */
  function followMap() {
    if (_destroyed || !_enabled) return;
    const moved = syncHost();
    const kept = loginWorks() && lease.follow();
    if (!moved && !kept) return;
    sync();
    notify();
  }

  /** Apply a choice of year, variant or flight years. */
  function choose(wanted) {
    const next = normalizeSelection(wanted, _selection);
    if (
      next.year === _selection.year &&
      next.variant === _selection.variant &&
      next.flightYears === _selection.flightYears
    )
      return false;
    _selection = next;
    sync();
    notify();
    return true;
  }

  /** The year's label, honest about reference years and partial ones. */
  function selectionText() {
    const entry = catalogueYear(_selection.year);
    if (entry.reference)
      return _selection.flightYears
        ? t(
            'Reference year {year} · Lantmäteriet (CC0) · each orange sheet gives the year most of it was flown',
            { year: entry.year },
          )
        : t(
            'Reference year {year} · Lantmäteriet (CC0) · flight years vary, turn on FLIGHT YEARS',
            { year: entry.year },
          );
    return t(
      '{year}, {variant} · Lantmäteriet (CC0) · partial coverage: where there is no photo this year, today’s map shows through',
      { year: entry.year, variant: t(VARIANT_WORDS[_selection.variant]) },
    );
  }

  /** What the row says beside the chips. */
  function infoText() {
    if (_statusError || renderer.failure?.()) return '';
    if (!_status) return t('Checking the Geotorget login…');
    if (!_status.hasLogin) return t(NO_LOGIN_INFO);
    if (_status.authFailed) return t(LOGIN_REFUSED_INFO);
    const parts = [];
    switch (_reason) {
      case 'host':
        parts.push(t(NO_IMAGERY_HOST));
        break;
      case 'lease':
        parts.push(t(WAITING_FOR_ESRI));
        break;
      case 'outside':
        parts.push(t(OUTSIDE));
        break;
      case 'zoom':
        parts.push(t(ZOOM_IN));
        break;
      case 'tileset-zoom':
        parts.push(t(TILESET_ZOOM));
        break;
      default:
        parts.push(selectionText());
        if (onTiles()) parts.push(t(OVER_3D));
    }
    // Why the photos are on the 3D tiles and not on Esri.
    if (onTiles() && lease.error()) parts.push(t(lease.error()));
    if (lease.notice()) parts.push(t(lease.notice()));
    if (_budgetSpent && _reason === null) parts.push(t(BUDGET_SPENT));
    return parts.join(' · ');
  }

  const layer = {
    id: HISTORICAL_ORTHO_LAYER_ID,
    name: 'Historical aerial photos (Sweden)',
    icon: '🕰️',
    source: 'Lantmäteriet',
    // The row names the key while the login is missing or refused.
    requiresKeyId: KEY_ID,
    // No polling: the photos are old, and the status is read once per
    // switch-on.
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer || null;
      return true;
    },

    enable(viewer) {
      if (_destroyed) return false;
      if (viewer) _viewer = viewer;
      _enabled = true;
      _status = null;
      _statusError = null;
      _tileErrors = 0;
      _budgetSpent = false;
      _rechecked = false;
      _removeMove?.();
      _removeMove =
        (_viewer && cameraOf(_viewer)?.on?.('moveEnd', onMove)) || null;
      _view = readView();
      syncHost();
      sync();
      notify();
      void readStatus();
      return true;
    },

    disable() {
      _statusRequest?.abort();
      _statusRequest = null;
      _removeMove?.();
      _removeMove = null;
      _enabled = false;
      _status = null;
      _statusError = null;
      _tileErrors = 0;
      _budgetSpent = false;
      _reason = 'off';
      renderer.hide();
      renderer.setSplit?.('none');
      destroySplit();
      // Back to Google 3D when the lease moved the map.
      lease.release();
      notify();
      return true;
    },

    async update() {},

    destroy() {
      if (_destroyed) return;
      if (_enabled) layer.disable();
      else lease.release();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      lease.attach(null);
      _mapStack = null;
      _offLocale?.();
      destroySplit();
      renderer.destroy();
      _rowListener = null;
      _viewer = null;
      _tileset = null;
      _destroyed = true;
    },

    /**
     * Keep the map controller for the comparison lease and hear every
     * settled stack switch, so the drapes follow the host and a manual
     * switch to Google 3D while the photos are on takes Esri back.
     */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      lease.attach(controller);
      _mapStack = controller || null;
      const off = controller?.subscribe?.(followMap);
      _unsubscribeMap = typeof off === 'function' ? off : null;
    },

    /** The photoreal tileset, for draping while the globe is hidden. */
    attachTileset(tileset) {
      _tileset = tileset || null;
      if (_enabled && syncHost()) {
        sync();
        notify();
      }
    },

    /**
     * Choose what is shown (tools and tests; the row's chips do the same):
     * `year`, `variant` ('bw', 'color', 'ir') and `flightYears` (a
     * boolean), and THEN | NOW: `swipe` (a boolean) and `split`, where its
     * divider stands (0–1). An unknown year or variant, a flightYears or
     * swipe that is not a boolean, or a split outside 0–1, changes nothing.
     * @param {{year?: number, variant?: string, flightYears?: boolean, swipe?: boolean, split?: number}} params
     * @returns {boolean}
     */
    setParams(params) {
      if (!params || typeof params !== 'object') return false;
      if (params.year != null && !catalogueYear(params.year)) return false;
      if (
        params.variant != null &&
        !HISTORICAL_ORTHO_VARIANTS.includes(params.variant)
      )
        return false;
      if (params.flightYears != null && typeof params.flightYears !== 'boolean')
        return false;
      if (params.swipe != null && typeof params.swipe !== 'boolean')
        return false;
      if (
        params.split != null &&
        !(
          typeof params.split === 'number' &&
          params.split >= 0 &&
          params.split <= 1
        )
      )
        return false;
      choose(params);
      chooseSwipe(params);
      return true;
    },

    getParams() {
      return { ..._selection, swipe: _swipe, split: _splitValue };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      if (!_enabled) return {};
      const { year, variant, flightYears } = _selection;
      const chips = HISTORICAL_ORTHO_CATALOGUE.map((entry) => ({
        id: `year-${entry.year}`,
        label: String(entry.year),
        active: entry.year === year,
        title: yearTitle(entry),
        onClick: () => choose({ year: entry.year }),
      }));
      const colour = hasVariant(year, 'color');
      chips.push({
        id: 'variant-color',
        label: t('COLOUR'),
        active: variant === 'color',
        disabled: !colour,
        title: colour
          ? t('Colour photos, 0.5 m, only the parts of Sweden flown that year')
          : t(
              'No colour photos for {year}: Lantmäteriet has colour for 2002–2005',
              { year },
            ),
        onClick: () =>
          choose({ variant: variant === 'color' ? 'bw' : 'color' }),
      });
      const infrared = hasVariant(year, 'ir');
      chips.push({
        id: 'variant-ir',
        label: t('IR'),
        active: variant === 'ir',
        disabled: !infrared,
        title: infrared
          ? t(
              'Infrared photos, 0.5 m, only the parts of Sweden flown that year',
            )
          : t(
              'No infrared photos for {year}: Lantmäteriet has infrared for 2003–2005',
              { year },
            ),
        onClick: () => choose({ variant: variant === 'ir' ? 'bw' : 'ir' }),
      });
      const sheets = hasFlightYears(year);
      chips.push({
        id: 'flight-years',
        label: t('FLIGHT YEARS'),
        active: sheets && flightYears,
        disabled: !sheets,
        title: sheets
          ? t(
              'Show the photo sheets with the year each was mostly flown, and the seams between the photos',
            )
          : t('Flight years exist only for the reference years 1960 and 1975'),
        onClick: () => choose({ flightYears: !flightYears }),
      });
      if (swipeOffered()) {
        const block = swipeBlock();
        const possible = !block;
        chips.push({
          id: 'swipe',
          label: t('THEN | NOW'),
          // A wanted swipe can always be switched off; only switching it on
          // needs the globe.
          active: _swipe,
          disabled: !possible && !_swipe,
          title: swipeTitle(block),
          onClick: () => chooseSwipe({ swipe: !_swipe }),
        });
      }
      return { chips, info: infoText() };
    },

    /** Nothing on the map is picked: a photo has no features. */
    findByQuery() {
      return null;
    },

    /**
     * What is shown, as one record without a position (the context panel
     * counts only placed records): year, variant, coverage and source.
     */
    getAnalystRecords() {
      if (!_enabled || renderer.ownedCount() === 0) return [];
      const entry = catalogueYear(_selection.year);
      const shown = selectedPhoto(_selection);
      return [
        {
          id: `${HISTORICAL_ORTHO_LAYER_ID}:${shown.layerId}`,
          name: t('Historical aerial photos {year}, {variant}', {
            year: entry.year,
            variant: t(VARIANT_WORDS[_selection.variant]),
          }),
          lat: null,
          lon: null,
          year: entry.year,
          referenceYear: entry.reference,
          variant: _selection.variant,
          coverage: entry.coverage,
          resolutionM: shown.resolutionM,
          flightYears: entry.reference && _selection.flightYears,
          onGoogle3dTiles: onTiles(),
          thenNowDivider: Boolean(_split) && renderer.getSplit?.() === 'left',
          source: 'Lantmäteriet',
          licence: 'CC0 1.0',
        },
      ];
    },

    getStats() {
      // Without a controller subscription the stats poll is the only steady
      // heartbeat, so it doubles as the map-stack watch.
      if (!_unsubscribeMap) followMap();
      if (!_enabled) return { count: 0, lastUpdate: _lastUpdate };
      // No time while nothing can be shown: the row reads UNAVAILABLE.
      if (_statusError) return { count: 0, error: _statusError };
      if (!_status) return { count: 0, loading: true };
      if (!_status.hasLogin)
        return { count: 0, error: NO_LOGIN, keyRequired: true };
      if (_status.authFailed)
        return { count: 0, error: LOGIN_REFUSED, keyRequired: true };
      if (renderer.failure?.()) return { count: 0, error: DRAW_FAILED };
      const guidance = (status, statusMessage) => ({
        count: 0,
        lastUpdate: _lastUpdate,
        status,
        statusMessage,
      });
      switch (_reason) {
        case 'host':
          return guidance('idle', NO_IMAGERY_HOST);
        case 'lease':
          return { count: 0, lastUpdate: _lastUpdate, loading: true };
        case 'outside':
          return guidance('idle', OUTSIDE);
        case 'zoom':
          return guidance('zoom-in', ZOOM_IN);
        case 'tileset-zoom':
          return guidance('zoom-in', TILESET_ZOOM);
        default:
          break;
      }
      const draped = renderer.ownedCount() > 0;
      return {
        count: draped ? 1 : 0,
        // A drape has no feature count; say what the row's ON means.
        ...(draped ? { countLabel: t('DRAPED') } : {}),
        lastUpdate: _lastUpdate,
        error: _tileErrors >= TILE_ERROR_LIMIT ? TILES_FAILING : null,
      };
    },

    /** Renderer, host, lease and status for tests and the live gate. */
    diagnostics() {
      return {
        host: _hostInfo.kind,
        ownedCount: renderer.ownedCount(),
        owned: renderer.getOwned?.().layerIds ?? [],
        hidden: _reason,
        lease: lease.status(),
        borrowedEsri: lease.borrowedEsri(),
        status: _status ? { ..._status } : null,
        tileErrors: _tileErrors,
        selection: { ..._selection },
        swipe: _swipe,
        split: _splitValue,
        divider: Boolean(_split),
      };
    },
  };
  return layer;
}
