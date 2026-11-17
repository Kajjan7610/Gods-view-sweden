/**
 * Security queues over the terminals (Swedish fork): when the view settles
 * near Arlanda, Landvetter or Bromma, each checkpoint Swedavia measures gets
 * a marker and label at its own position — "T5 · 3 min", green, yellow or orange by
 * length — read again every three minutes while the view stays. A click on
 * a label opens the airport board's security tab.
 */
import { onLocaleChange, t } from '../i18n/index.js';
import { SWEDAVIA_AIRPORTS } from '../data/swedaviaAirports.js';
import {
  airportUnder,
  queueMarkers,
  queueReachKm,
} from './airportBoardModel.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../render/rendererOf.js';
import { inputFor } from '../input/dispatcher.js';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

/** The labels show while the view is this low and, at the very most, this
    near an airport; how near also follows the view (queueReachKm). */
const NEAR_KM = 20;
const NEAR_HEIGHT_M = 40_000;
const REFRESH_MS = 3 * 60_000;
/** Queue minutes older than this are no longer the queue. */
const STALE_SHOW_MS = 15 * 60_000;
const SETTLE_DELAY_MS = 600;
/** Above the terminal roofs; the marker also draws through the 3D tiles. */
const MARKER_HEIGHT_M = 35;
export const AIRPORT_QUEUES_ID = 'airport-queues';
const LABEL_SOURCE_ID = 'airport-queue-labels';
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 20,
  collisionCapacity: 12,
  moving: false,
});
const PICK_PREFIX = 'airport-queue:';
const LEVEL_COLORS = Object.freeze({
  short: '#69f0ae',
  medium: '#ffd54f',
  long: '#ffab40',
});
const OUTLINE_COLOR = '#04101a';
const QUEUE_AIRPORTS = SWEDAVIA_AIRPORTS.filter((airport) => airport.queues);

/**
 * Own the queue labels for one scene object (`viewer`). Text goes through
 * the world-overlay host (`overlayHost`: setEntries, setVisible,
 * clearSource, hitTest); the markers under it are one points set.
 * @param {{ openBoard: (iata: string) => void }} options
 */
export function createAirportQueues({
  viewer: host,
  overlayHost,
  openBoard,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (forHost) => inputFor(forHost),
}) {
  let destroyed = false;
  let airport = null;
  let markers = [];
  let request = null;
  /** When the markers shown were read. */
  let loadedAt = 0;
  let refreshTimer = null;
  let settleTimer = null;
  const dots = drawOf(host).points({ id: AIRPORT_QUEUES_ID });
  const requestRender = () => findFrame(host)?.requestRender(AIRPORT_QUEUES_ID);

  const cockpit = () =>
    documentRef?.body?.classList?.contains('cockpit-mode') === true;

  function viewCenter() {
    const height = findCamera(host)?.pose().height;
    if (!Number.isFinite(height)) return null;
    const canvas = canvasOf(host);
    const hit = canvas
      ? findQuery(host)?.pickEllipsoid(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        )
      : null;
    if (!hit) return null;
    const { lat, lon } = toLonLatH(hit);
    return { lat, lon, height };
  }

  function draw() {
    const shown = Boolean(airport) && !cockpit();
    const items = [];
    const entries = [];
    for (const marker of shown ? markers : []) {
      const accent = LEVEL_COLORS[marker.level];
      const height = airport.groundM + MARKER_HEIGHT_M;
      const id = `${PICK_PREFIX}${airport.iata}:${marker.key}`;
      items.push({
        id,
        pos: { lon: marker.lon, lat: marker.lat, height },
        pixelSize: 9,
        color: accent,
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 2,
        disableDepthTest: Number.POSITIVE_INFINITY,
      });
      const fast =
        marker.fastTrack === null
          ? null
          : `${t('Fast track')} ${t('{minutes} min', { minutes: marker.fastTrack })}`;
      entries.push({
        id,
        position: fromDegrees(marker.lon, marker.lat, height),
        variant: 'label',
        title: [
          marker.terminal,
          marker.onlyFastTrack
            ? `${t('Fast track')} ${t('{minutes} min', { minutes: marker.minutes })}`
            : t('{minutes} min', { minutes: marker.minutes }),
          fast,
        ]
          .filter(Boolean)
          .join(' · '),
        accent,
        // The longest queue wins a crowded view.
        priority: marker.minutes,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: true,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 8,
        verticalOnly: true,
        placement: 'above',
      });
    }
    dots.set(items);
    dots.show = shown;
    overlayHost.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
    overlayHost.setVisible?.(LABEL_SOURCE_ID, shown);
    requestRender();
  }
  async function load() {
    if (!airport || destroyed) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const forAirport = airport;
    try {
      const response = await fetchImpl(
        `/api/airport-board?iata=${forAirport.iata}&only=security`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (destroyed || airport !== forAirport) return;
      // A fallback from over a quarter of an hour ago is not the queue.
      const old =
        body?.stale === true &&
        Number.isFinite(body.updatedAt) &&
        now() - body.updatedAt > STALE_SHOW_MS;
      markers = old ? [] : queueMarkers(body?.security);
      loadedAt = now();
      draw();
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn('[AirportQueues] load failed:', error?.message || error);
      // Without a fresh answer the minutes on the map grow old: after a
      // quarter of an hour they go.
      if (
        error?.name !== 'AbortError' &&
        airport === forAirport &&
        markers.length &&
        now() - loadedAt > STALE_SHOW_MS
      ) {
        markers = [];
        draw();
      }
    } finally {
      if (request === controller) request = null;
    }
    clearTimeout(refreshTimer);
    refreshTimer = airport
      ? setTimeout(() => {
          refreshTimer = null;
          if (documentRef?.visibilityState !== 'hidden') void load();
        }, REFRESH_MS)
      : null;
  }

  function settle() {
    settleTimer = null;
    if (destroyed) return;
    const center = viewCenter();
    // Only an airport whose terminals are in view: the queues cost a call
    // against Swedavia's daily allowance.
    const next = cockpit()
      ? null
      : airportUnder(center, QUEUE_AIRPORTS, {
          km: queueReachKm(center?.height, NEAR_KM),
          height: NEAR_HEIGHT_M,
        });
    if (next?.iata === airport?.iata) {
      // The same airport: back from a hidden page, or out of cockpit.
      if (dots.show !== (Boolean(airport) && !cockpit())) draw();
      if (airport && !refreshTimer && !request) void load();
      return;
    }
    airport = next;
    markers = [];
    loadedAt = 0;
    request?.abort();
    clearTimeout(refreshTimer);
    refreshTimer = null;
    draw();
    if (airport) void load();
  }
  const removeMoveEnd = findCamera(host)?.on('moveEnd', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
  });

  registerPickOwner(
    AIRPORT_QUEUES_ID,
    (pickedId) =>
      typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
  );
  // A scene with no renderer input bound takes no clicks.
  let clicks = null;
  try {
    clicks = input(host) ?? null;
  } catch {
    clicks = null;
  }
  const removeClick = clicks?.onClick((click) => {
    if (!airport || !dots.show) return;
    // The label first (it is the bigger target), then the marker under it.
    const at = click.screenPosition;
    const label = overlayHost.hitTest?.(at?.x, at?.y, {
      sourceId: LABEL_SOURCE_ID,
    });
    const id = label?.entryId ?? resolvePickId(click.topHit);
    if (typeof id === 'string' && id.startsWith(PICK_PREFIX))
      openBoard(airport.iata);
  });

  const removeLocale = onLocaleChange(draw);
  // Looked at again after being hidden: the refresh that was skipped.
  const onVisible = () => {
    if (documentRef?.visibilityState === 'hidden') return;
    if (airport && !refreshTimer && !request) void load();
  };
  documentRef?.addEventListener?.('visibilitychange', onVisible);

  return {
    destroy() {
      destroyed = true;
      request?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(settleTimer);
      removeMoveEnd?.();
      removeLocale?.();
      documentRef?.removeEventListener?.('visibilitychange', onVisible);
      removeClick?.();
      unregisterPickOwner(AIRPORT_QUEUES_ID);
      overlayHost.clearSource?.(LABEL_SOURCE_ID);
      dots.dispose();
      requestRender();
    },
  };
}
