import * as Cesium from 'cesium';
import { msg, onLocaleChange, t } from '../../i18n/index.js';
import { createGroundHeights } from '../groundHeights.js';
import { createPowerDay } from './dayPanel.js';
import {
  SWEDISH_AREAS,
  exchangeByCountry,
  exchangeTotals,
  flowColor,
  flowWidth,
  linkTouches,
} from './records.js';
import {
  POWER_GRID_OVERLAY_SOURCE_ID,
  buildAreaCard,
  countryName,
  formatClock,
  formatMw,
  netText,
  zoneName,
} from './cards.js';
import { FlowMaterialProperty, flowRepeat, flowSpeed } from './flowMaterial.js';
export * from './records.js';
export * from './cards.js';
export { createPowerGridSource } from './source.js';

const PICK_PREFIX = 'se-kraftnat:';
const LABEL_SOURCE_ID = 'power-grid-labels';
/** Flow lines float above terrain and buildings. */
const LINE_HEIGHT_M = 12_000;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 40,
  collisionCapacity: 40,
  moving: false,
});
/** Which flows the map shows. */
const SHOW_OPTIONS = Object.freeze([
  Object.freeze({ id: 'all', label: msg('All') }),
  Object.freeze({ id: 'import', label: msg('Imports') }),
  Object.freeze({ id: 'export', label: msg('Exports') }),
  Object.freeze({ id: 'internal', label: msg('In Sweden') }),
]);
const AREA_BY_ID = new Map(SWEDISH_AREAS.map((area) => [area.id, area]));
/**
 * The scene renders on request when nothing else animates; moving chevrons
 * ask for a frame this often (about 15 a second, a quarter of continuous
 * rendering), and for a while after each redraw so new lines finish building.
 */
const ANIMATION_FRAME_MS = 66;
const SETTLE_MS = 2000;
/** A resized window shows more or less; Cesium sizes itself a frame later. */
const RESIZE_SETTLE_MS = 250;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** How faint a link outside the highlighted country draws. */
const DIMMED_ALPHA = 0.18;

/** The point halfway along a link, for its label. */
function midpoint([lon1, lat1], [lon2, lat2]) {
  return [(lon1 + lon2) / 2, (lat1 + lat2) / 2];
}

/** The foreign end of a link to or from Sweden: its zone and landing place. */
const foreignZone = (link) => (link.kind === 'import' ? link.from : link.to);
const foreignPoint = (link) =>
  link.kind === 'import' ? link.fromPoint : link.toPoint;

/** What tells one snapshot's drawing from another's; not when it was read. */
const signatureOf = (snapshot) =>
  JSON.stringify([
    snapshot.updated,
    snapshot.stale,
    snapshot.links,
    snapshot.areas,
    snapshot.production,
  ]);

/** Kilometres between two [lon, lat] points. */
function kilometres([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Own one Swedish power-system display: an arrow on every link to and
 * between the Swedish bidding zones, pointing the way the power flows, as
 * thick as the flow, labelled in MW; and a card per zone with its import,
 * export and Sweden's production by type. Share links carry it as token 0r.
 */
export function createPowerGridLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  terrain = null,
  requestRender = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Power grid requires a snapshot source');
  // With ground heights the zone and neighbour dots clamp to terrain only
  // (see groundHeights.js).
  const _ground = createGroundHeights(terrain, () => render());
  const onGround = (id, [lon, lat]) =>
    Cesium.Cartesian3.fromDegrees(lon, lat, _ground.heightOf(id));
  const groundRows = () => [
    ...SWEDISH_AREAS.map((area) => ({ id: area.id, point: area.point })),
    ..._snapshot.links
      .filter((link) => link.kind !== 'internal')
      .map((link) => ({ id: `end:${link.id}`, point: foreignPoint(link) })),
  ];
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _selectedId = null;
  let _snapshot = { links: [], areas: [], production: {}, updated: null };
  /** 'all', 'import', 'export' or 'internal'. */
  let _show = 'all';
  /** A neighbouring country whose links stand out, or null. */
  let _focus = null;
  let _offLocale = null;
  let _ticker = null;
  /** The drawn snapshot's signature: an identical answer draws nothing. */
  let _signature = null;
  /** The snapshot time the day panel last followed. */
  let _dayKey = null;
  /** The drawn lines' ends and bounds, for the camera test. */
  let _lineBounds = [];
  /** Whether a drawn line may be on screen; decided on camera events. */
  let _inView = false;
  /** Whether some drawn line moves: 1 MW or more and not dimmed. */
  let _flowing = false;
  /** Whether the reader asked the system for reduced motion. */
  let _still = false;
  let _motionQuery = null;
  let _offCameraChanged = null;
  let _offCameraMoveEnd = null;
  let _resizeTimer = null;
  const _occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  /** The day's production, consumption and exchange on the right rail. */
  const _day = createPowerDay({ source });
  /**
   * Each drawing gives its lines and dots new ids: an entity removed and
   * added again under the same id inside one suspension is reported as
   * neither, so Cesium would keep drawing the old line or dot.
   */
  let _drawing = 0;
  let _settleUntil = 0;

  const frame = () =>
    requestRender
      ? requestRender('power-grid-flow')
      : _viewer?.scene?.requestRender?.();
  /** Frames are wanted while lines in view move or finish building. */
  const framesWanted = () =>
    _enabled && _inView && ((_flowing && !_still) || Date.now() < _settleUntil);

  function tick() {
    if (!framesWanted()) {
      clearInterval(_ticker);
      _ticker = null;
    } else if (!globalThis.document?.hidden) frame();
  }

  /** Start or stop asking for frames; the tick itself only reads flags. */
  function syncTicker() {
    if (framesWanted()) _ticker ??= setInterval(tick, ANIMATION_FRAME_MS);
    else if (_ticker) {
      clearInterval(_ticker);
      _ticker = null;
    }
  }

  /**
   * Whether a drawn line may be on screen: on this side of the globe and
   * inside the camera's frustum. Where that cannot be told (no camera, 2D,
   * Columbus view) the lines count as in view.
   */
  function linesInView() {
    if (!_lineBounds.length) return false;
    const camera = _viewer?.camera;
    if (!camera?.positionWC || _viewer.scene?.mode !== Cesium.SceneMode.SCENE3D)
      return true;
    _occluder.cameraPosition = camera.positionWC;
    const volume = camera.frustum?.computeCullingVolume?.(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    for (let i = 0; i < _lineBounds.length; i++) {
      const line = _lineBounds[i];
      if (
        (_occluder.isPointVisible(line.from) ||
          _occluder.isPointVisible(line.to) ||
          _occluder.isPointVisible(line.sphere.center)) &&
        (!volume ||
          volume.computeVisibility(line.sphere) !== Cesium.Intersect.OUTSIDE)
      )
        return true;
    }
    return false;
  }

  /** The camera or the lines changed: decide again, here and not per tick. */
  function updateInView() {
    const inView = linesInView();
    if (inView === _inView) return;
    _inView = inView;
    // Lines drawn while out of view finish building now.
    if (inView) _settleUntil = Date.now() + SETTLE_MS;
    syncTicker();
  }

  function onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(updateInView, RESIZE_SETTLE_MS);
  }

  function onMotionChange() {
    _still = _motionQuery?.matches === true;
    // Each line's material took its speed when it was made.
    if (_enabled) render();
  }

  /** Follow, or stop following, the camera, the window and the motion wish. */
  function watchView(on) {
    _offCameraChanged?.();
    _offCameraMoveEnd?.();
    _offCameraChanged = _offCameraMoveEnd = null;
    clearTimeout(_resizeTimer);
    _resizeTimer = null;
    globalThis.removeEventListener?.('resize', onResize);
    _motionQuery?.removeEventListener?.('change', onMotionChange);
    if (!on) return;
    const camera = _viewer?.camera;
    _offCameraChanged = camera?.changed?.addEventListener(updateInView) ?? null;
    _offCameraMoveEnd = camera?.moveEnd?.addEventListener(updateInView) ?? null;
    globalThis.addEventListener?.('resize', onResize);
    _motionQuery ??= globalThis.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
    _motionQuery?.addEventListener?.('change', onMotionChange);
    _still = _motionQuery?.matches === true;
  }

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const shownLinks = () =>
    _snapshot.links.filter((link) => _show === 'all' || link.kind === _show);
  const dimmed = (link) => _focus !== null && !linkTouches(link, _focus);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const area = _selectedId ? AREA_BY_ID.get(_selectedId) : null;
    if (!area || !_snapshot.links.length) {
      _selectedId = null;
      overlayHost.setEntries(
        POWER_GRID_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildAreaCard(area, _snapshot);
    card.position = onGround(area.id, area.point);
    overlayHost.setEntries(
      POWER_GRID_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedArea(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    // "SE3:7": the zone, then the drawing its dot belongs to.
    const id = pickId.slice(PICK_PREFIX.length).split(':')[0];
    return AREA_BY_ID.has(id) ? id : null;
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
      // A card under the click, this layer's or another's, is not the ground.
      if (cardHit) return;
      const picked = _viewer.scene.pick(click.position);
      const hit = picked ? pickedArea(picked) : null;
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
    if (!overlayHost) return;
    for (const id of [POWER_GRID_OVERLAY_SOURCE_ID, LABEL_SOURCE_ID]) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  const LABEL_BASE = Object.freeze({
    variant: 'label',
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    verticalOnly: true,
    placement: 'above',
  });

  function publishLabels() {
    if (!overlayHost) return;
    const entries = [];
    if (_enabled) {
      for (const area of SWEDISH_AREAS)
        entries.push({
          ...LABEL_BASE,
          id: `power-grid-area:${area.id}`,
          position: onGround(area.id, area.point),
          title: area.id,
          accent: flowColor('internal'),
          priority: 2000,
        });
      for (const link of shownLinks()) {
        // A highlighted country keeps the labels to itself.
        if (dimmed(link)) continue;
        entries.push({
          ...LABEL_BASE,
          id: `power-grid-flow:${link.id}`,
          position: Cesium.Cartesian3.fromDegrees(
            ...midpoint(link.fromPoint, link.toPoint),
            LINE_HEIGHT_M,
          ),
          // "Polen → SE4 · 483 MW": where it comes from, where it goes.
          title: `${zoneName(link.from)} → ${zoneName(link.to)} · ${t(
            '{mw} MW',
            { mw: formatMw(link.mw) },
          )}`,
          accent: flowColor(link.kind),
          priority: 1000 + link.mw,
        });
        if (link.kind !== 'internal')
          entries.push({
            ...LABEL_BASE,
            id: `power-grid-end:${link.id}`,
            position: onGround(`end:${link.id}`, foreignPoint(link)),
            title: zoneName(foreignZone(link)),
            accent: '#b0bec5',
            priority: 500,
          });
      }
    }
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
  }

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      _drawing++;
      _lineBounds = [];
      _flowing = false;
      for (const link of shownLinks()) {
        if (link.mw < 1) continue;
        const faint = dimmed(link);
        const positions = Cesium.Cartesian3.fromDegreesArrayHeights([
          ...link.fromPoint,
          LINE_HEIGHT_M,
          ...link.toPoint,
          LINE_HEIGHT_M,
        ]);
        _lineBounds.push({
          from: positions[0],
          to: positions[1],
          sphere: Cesium.BoundingSphere.fromPoints(positions),
        });
        if (!faint) _flowing = true;
        entities.add({
          id: `power-grid-line:${link.id}:${_drawing}`,
          polyline: {
            positions,
            width: flowWidth(link.mw) * 2,
            arcType: Cesium.ArcType.GEODESIC,
            // Chevrons running the way the power flows, faster as it grows.
            material: new FlowMaterialProperty(
              Cesium.Color.fromCssColorString(flowColor(link.kind)).withAlpha(
                faint ? DIMMED_ALPHA : 0.9,
              ),
              flowRepeat(kilometres(link.fromPoint, link.toPoint)),
              faint ? 0 : flowSpeed(link.mw),
            ),
          },
        });
        if (link.kind !== 'internal' && !faint)
          entities.add({
            id: `power-grid-end:${link.id}:${_drawing}`,
            position: onGround(`end:${link.id}`, foreignPoint(link)),
            point: {
              pixelSize: 8,
              color: Cesium.Color.fromCssColorString('#b0bec5'),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
              outlineWidth: 1,
              heightReference: _ground.enabled
                ? Cesium.HeightReference.CLAMP_TO_TERRAIN
                : Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
      }
      for (const area of SWEDISH_AREAS)
        entities.add({
          id: `${PICK_PREFIX}${area.id}:${_drawing}`,
          position: onGround(area.id, area.point),
          point: {
            pixelSize: 18,
            color: Cesium.Color.fromCssColorString(flowColor('internal')),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            heightReference: _ground.enabled
              ? Cesium.HeightReference.CLAMP_TO_TERRAIN
              : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
    } finally {
      entities.resumeEvents();
    }
    publishLabels();
    if (_selectedId) publishSelectedCard();
    frame();
    _inView = linesInView();
    _settleUntil = Date.now() + SETTLE_MS;
    syncTicker();
  }

  const layer = {
    id: 'power-grid',
    name: 'Power Grid (Sweden)',
    icon: '🔌',
    source: 'Svenska kraftnät',
    // SvK publishes quarter-hours; the proxy keeps an answer five minutes.
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Power grid layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('power-grid');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      // Country names on the map follow the reader's language.
      _offLocale = onLocaleChange(() => {
        publishLabels();
        if (_selectedId) publishSelectedCard();
        _day.publish();
      });
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(POWER_GRID_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(LABEL_SOURCE_ID, true);
      installClickHandler();
      publishLabels();
      watchView(true);
      _inView = linesInView();
      _settleUntil = Date.now() + SETTLE_MS;
      syncTicker();
      _day.setActive(true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _ground.cancel();
      _enabled = false;
      // The next answer after a pause draws, and asks for heights, again.
      _signature = null;
      watchView(false);
      syncTicker();
      _day.setActive(false);
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
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        _lastError = null;
        const signature = signatureOf(snapshot);
        if (signature !== _signature) {
          _signature = signature;
          _snapshot = snapshot;
          if (
            _focus !== null &&
            !exchangeByCountry(snapshot.links).some(
              (entry) => entry.country === _focus,
            )
          )
            _focus = null;
          render();
          _ground.place(groundRows());
        }
        // The day grows only when Svenska kraftnät's clock has moved on; a
        // load that failed or came back old is asked for again all the same.
        const dayKey = `${snapshot.updated}/${snapshot.production?.at}`;
        if (dayKey !== _dayKey || _day.wantsRetry()) {
          _dayKey = dayKey;
          _day.refresh();
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:PowerGrid] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Power grid unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _offLocale?.();
      _offLocale = null;
      _day.destroy();
      _ground.clear();
      _snapshot = { links: [], areas: [], production: {}, updated: null };
      _dayKey = null;
      _focus = null;
      _lineBounds = [];
      _motionQuery = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /**
     * Connect the right-rail day panel: `{publish(view|null), connect(actions)}`.
     */
    attachDayPanel(panel) {
      _day.attach(panel);
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const links = _snapshot.links;
      if (!links.length) return {};
      const totals = exchangeTotals(links);
      const countries = exchangeByCountry(links);
      const redraw = () => {
        render();
        _rowListener?.();
      };
      const legend = [
        ...countries.map((entry) => ({
          label: `${countryName(entry.country)}: ${netText(entry.net)}`,
          color: flowColor(entry.net >= 0 ? 'export' : 'import'),
        })),
        { label: t('Between Swedish zones'), color: flowColor('internal') },
      ];
      legend[0] = {
        ...legend[0],
        blurb: t(
          'Moving chevrons show the power flowing now on each link to and between the four bidding zones, as thick and as fast as the flow. Pick a direction, or a neighbouring country to see its links alone. Click a zone for its import, export and Sweden’s production by type.',
        ),
      };
      return {
        info: Number.isFinite(_snapshot.updated)
          ? t('At {time}: in {import} MW · out {export} MW · net {net}', {
              time: formatClock(_snapshot.updated),
              import: formatMw(totals.import),
              export: formatMw(totals.export),
              net: netText(totals.net),
            })
          : '',
        infoTitle: t(
          'Sweden’s exchange with its neighbours, summed over the links for the latest quarter-hour (Svenska kraftnät).',
        ),
        segmented: {
          id: 'power-grid-show',
          ariaLabel: t('Which flows to show'),
          options: SHOW_OPTIONS.map((option) => ({
            id: `show-${option.id}`,
            label: t(option.label),
            active: _show === option.id,
            onClick: () => {
              _show = option.id;
              redraw();
            },
          })),
        },
        chips: countries.map((entry) => ({
          id: `country-${entry.country}`,
          label: countryName(entry.country),
          active: _focus === entry.country,
          title: t('{country}: in {import} MW · out {export} MW', {
            country: countryName(entry.country),
            import: formatMw(entry.import),
            export: formatMw(entry.export),
          }),
          onClick: () => {
            _focus = _focus === entry.country ? null : entry.country;
            redraw();
          },
        })),
        legend,
      };
    },

    getStats() {
      return {
        count: _snapshot.links.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
