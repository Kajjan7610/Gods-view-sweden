import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initGeoFileImport } from '../ui/geoFileImport.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { createCityDossier } from '../ui/cityDossier.js';
import { createAirportBoard } from '../ui/airportBoard.js';
import { createAirportQueues } from '../ui/airportQueues.js';
import { createAirportRoutes } from '../ui/airportRoutes.js';
import { useAirportRoutesStore } from '../ui/stores/airportRoutes.js';
import { createCockpitFlightLeg } from '../ui/cockpitFlightLeg.js';
import { createVmaBanner } from '../ui/vmaBanner.js';
import { useVmaBannerStore } from '../ui/stores/vmaBanner.js';
import { useCockpitFlightLegStore } from '../ui/stores/cockpitFlightLeg.js';
import * as worldOverlays from '../overlays/worldOverlay.js';
import { useCityDossierStore } from '../ui/stores/cityDossier.js';
import { usePowerDayStore } from '../ui/stores/powerDay.js';
import { useAirportBoardStore } from '../ui/stores/airportBoard.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installViews, isEmbeddedInline } from './embed.js';
import {
  installScopeMask,
  destroyScopeMask,
  isScopeMaskEnabled,
} from '../scopeMask.js';
import { KEYHOLE_OUTER_RADIUS } from '../celestialRing.js';
import { installGlobeInViewRecovery } from './viewer.js';
import { installLayerReleaseTrim } from '../sceneCommandRelease.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/** Attach scene tools, rendering listeners and the application debug handle. */
export function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  drawMarkActions = [],
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController, operations } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager, {
    dataPacks: sceneDataPacks,
    isMapStackAvailable: (id) =>
      mapStackController?.isStackAvailable(id) === true,
  });
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => sceneDirector.destroy());
  defer(
    installGlobeInViewRecovery(viewer, {
      // The scope mask hides everything outside its keyhole.
      keyholeRadius: () => (isScopeMaskEnabled() ? KEYHOLE_OUTER_RADIUS : 0),
      // An authored scene frames its own shots, holds included.
      paused: () => sceneDirector.running,
    }),
  );
  onSceneDirector?.(sceneDirector);
  const annotations = initAnnotations({
    viewer,
    tileset,
    placeSearch,
    resolver: operations.annotationResolver,
  });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  const displayStore = useDisplayStore(applicationPinia());
  // The Display panel's controls answer through the store; returns the
  // disconnect.
  const connectDisplay = (actions) => {
    const token = displayStore.connect(actions);
    return () => displayStore.detach(token);
  };
  // UTILITIES ▸ Draw: the same whiteboard, drawn by hand. It claims the pointer
  // while a session is open, so its teardown belongs to the application
  // lifetime rather than to whoever last pressed the button. A row's fly-to
  // goes through the shell's navigation policy, as Import's does.
  // `drawMarkActions` are an application's own buttons on a drawn area's or
  // line's row (annotations/drawMarks.js); the standalone shell adds none.
  const drawTool = initDrawTool({
    viewer,
    annotations,
    navigation: styleManager,
    publish: (view) => displayStore.publishDraw(view),
    connect: connectDisplay,
    markActions: drawMarkActions,
  });
  defer(() => drawTool?.destroy());
  // UTILITIES ▸ Import: the person's own GeoJSON/KML/KMZ/GPX files, each its
  // own data source. They live for the page session, so the application
  // lifetime removes them and the drop listeners on the viewer container.
  const geoFileImport = initGeoFileImport({
    viewer,
    navigation: styleManager,
    ground: operations.surface?.groundFloor,
    subscribeMapSource: (listener) => mapStackController?.subscribe?.(listener),
    publish: (view) => displayStore.publishGeoImport(view),
    connect: connectDisplay,
  });
  defer(() => geoFileImport?.destroy());
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to the application
  // lifetime. The tileset lets the layer drape while the globe is hidden.
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  if (recentImagery) {
    recentImagery.attachTileset(tileset);
    const imageryBoxTool = initImageryBoxTool({
      viewer,
      onBox: (box) => recentImagery.setBox(box),
      onCancel: (reason, message, box) => {
        if (message) recentImagery.reportBoxRefusal(message, box);
      },
      onActive: (active) => recentImagery.setToolActive(active),
      // The tool takes Escape in a capture listener, so the panel's order
      // (clear a preview before cancelling the tool) is applied here.
      onEscape: () => recentImagery.clearPreview(),
    });
    // The readout mounts in its rail body through the layer panel, like the
    // weather readout.
    data.presentation.attachRecentImagery((container) =>
      createRecentImageryPanel({
        container,
        viewer,
        layer: recentImagery,
        tool: imageryBoxTool,
      }),
    );
    // The live gate's handle (scripts/qa-recent-imagery.mjs).
    const recentImageryHandle = { layer: recentImagery, tool: imageryBoxTool };
    window.__gevRecentImagery = recentImageryHandle;
    defer(() => {
      if (window.__gevRecentImagery === recentImageryHandle)
        delete window.__gevRecentImagery;
      data.presentation.attachRecentImagery(null);
      imageryBoxTool?.destroy();
    });
  }
  // The POWER panel: the day's production, consumption and exchange while the
  // power grid layer is on (Swedish fork).
  const powerDayStore = usePowerDayStore(applicationPinia());
  const powerGrid = dataManager.layers.get('power-grid')?.module;
  powerGrid?.attachDayPanel?.({
    publish: (view) => powerDayStore.publish(view),
    connect: (actions) => powerDayStore.connect(actions),
  });
  defer(() => powerGrid?.attachDayPanel?.(null));
  // The CITY panel follows the town the view settles over (Swedish fork).
  const cityDossierStore = useCityDossierStore(applicationPinia());
  const cityDossier = createCityDossier({
    viewer,
    dataManager,
    publish: (view) => cityDossierStore.publish(view),
    connect: (actions) => cityDossierStore.connect(actions),
    // A playing scene owns the camera; a first visit then gets no orbit.
    isCameraBusy: () => sceneDirector.getPlaybackStatus?.()?.running === true,
    overlayHost: {
      setEntries: worldOverlays.setOverlayEntries,
      setVisible: worldOverlays.setOverlaySourceVisible,
      clearSource: worldOverlays.clearOverlaySource,
      hitTest: worldOverlays.hitTestWorldOverlay,
    },
  });
  defer(() => cityDossier.destroy());
  // Krisinformation.se's public alerts (VMA), across the top while active.
  const vmaBannerStore = useVmaBannerStore(applicationPinia());
  const vmaBanner = createVmaBanner({
    publish: (rows) => vmaBannerStore.publish(rows),
    connect: (actions) => vmaBannerStore.connect(actions),
  });
  defer(() => vmaBanner.destroy());
  // The cockpit's Swedavia card: the flown aircraft's own board rows.
  const cockpitFlightLegStore = useCockpitFlightLegStore(applicationPinia());
  const cockpitFlightLeg = createCockpitFlightLeg({
    dataManager,
    publish: (view) => cockpitFlightLegStore.publish(view),
  });
  defer(() => cockpitFlightLeg.destroy());
  // A Swedavia airport's whole day, from the dossier or over the airport.
  const airportBoardStore = useAirportBoardStore(applicationPinia());
  const airportBoard = createAirportBoard({
    viewer,
    dataManager,
    onFollow: (icao24, iata) => cockpitFlightLeg.hint(icao24, iata),
    onShowRoutes: (iata) => airportRoutes.show(iata),
    publish: (view) => airportBoardStore.publish(view),
    connect: (actions) => airportBoardStore.connect(actions),
  });
  defer(() => airportBoard.destroy());
  // Queue labels over the terminals; a click opens the board's queues.
  const airportQueues = createAirportQueues({
    viewer,
    overlayHost: {
      setEntries: worldOverlays.setOverlayEntries,
      setVisible: worldOverlays.setOverlaySourceVisible,
      clearSource: worldOverlays.clearOverlaySource,
      hitTest: worldOverlays.hitTestWorldOverlay,
    },
    openBoard: (iata) => airportBoard.open(iata, 'security'),
  });
  defer(() => airportQueues.destroy());
  // Today's routes on the globe; a destination opens the board on it.
  const airportRoutesStore = useAirportRoutesStore(applicationPinia());
  const airportRoutes = createAirportRoutes({
    viewer,
    overlayHost: {
      setEntries: worldOverlays.setOverlayEntries,
      setVisible: worldOverlays.setOverlaySourceVisible,
      clearSource: worldOverlays.clearOverlaySource,
      hitTest: worldOverlays.hitTestWorldOverlay,
    },
    publish: (view) => airportRoutesStore.publish(view),
    openBoard: (iata, query) => airportBoard.open(iata, 'departures', query),
  });
  defer(
    airportRoutesStore.connect({
      hide: () => airportRoutes.hide(),
      openBoard: (iata) => airportBoard.open(iata),
    }),
  );
  defer(() => airportRoutes.destroy());
  if (startChrome)
    defer(startChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);
  // Cesium keeps a turned-off layer's draw commands (and so all its entities)
  // alive in reused per-pass arrays; trim them after each disable.
  defer(
    installLayerReleaseTrim({
      scene: viewer.scene,
      dataManager,
      requestRender: governorRequestRender,
    }),
  );

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    // A panel's host may report it hidden while it is on screen; the panel
    // keeps drawing itself (see keepPanelRendering in embed.js).
    const hidden = document.hidden && !isEmbeddedInline();
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      data.presentation.flushVisible();
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  const voiceCommands = initGevVoiceCommands({
    ...voice,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;
  defer(
    installViews({
      shell: styleManager,
      viewer,
      dataManager,
      run: (name, args) => voiceCommands.runner(name, args, { signal }),
      signal,
    }),
  );
  return { sceneDirector, annotations, voiceCommands };
}
