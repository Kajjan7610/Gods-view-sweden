/**
 * The airport board (Swedish fork): one Swedavia airport's whole day of
 * departures and arrivals and its security queues, opened from the city
 * dossier's flights or from the card that appears when the view settles
 * over the airport. The day comes from /api/airport-board and is read again
 * every three minutes while the board is open and the page is visible.
 */
import * as Cesium from 'cesium';
import { getLocale, msg, onLocaleChange, t } from '../i18n/index.js';
import { swedaviaAirport } from '../data/swedaviaAirports.js';
import {
  aircraftFor,
  aircraftIndex,
  airportUnder,
  flightTone,
  matchesQuery,
  nowIndex,
  queueLevel,
} from './airportBoardModel.js';

const REFRESH_MS = 3 * 60_000;
/** The "now" line and gone rows move on this often while the board shows. */
const TICK_MS = 60_000;
const SETTLE_DELAY_MS = 600;
/** How long the flights layer's contacts are read once for the board. */
const AIRCRAFT_INDEX_MS = 20_000;
const FLIGHTS_LAYER = 'flights';
const AIRCRAFT_INDEX_MAX = 50_000;
/** A checkpoint is shown from this far south and this high (about 1.2 km
    back at a 35° pitch, so its label sits near mid-screen). */
const QUEUE_VIEW_SOUTH_DEG = 0.0105;
const QUEUE_VIEW_HEIGHT_M = 900;
const TABS = Object.freeze([
  ['departures', msg('Departures'), 'flight_takeoff'],
  ['arrivals', msg('Arrivals'), 'flight_land'],
  ['security', msg('Security'), 'security'],
]);
const SCOPES = Object.freeze({
  S: msg('Schengen'),
  I: msg('Outside Schengen'),
  D: msg('Domestic'),
});

const clock = (ms) =>
  ms == null
    ? ''
    : new Intl.DateTimeFormat(getLocale(), {
        timeZone: 'Europe/Stockholm',
        hour: '2-digit',
        minute: '2-digit',
      }).format(ms);
const longDate = (date) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(Date.parse(`${date}T12:00:00Z`));
const bilingual = (value) =>
  !value
    ? ''
    : String(getLocale() || '').startsWith('sv')
      ? value.sv
      : value.en;

/** Own the board for one viewer; `publish` receives `{ card, board }`. */
export function createAirportBoard({
  viewer,
  // The flights layer, for following a board row's aircraft (optional).
  dataManager = null,
  publish,
  connect,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  documentRef = globalThis.document,
}) {
  let destroyed = false;
  let airport = null;
  let tab = 'departures';
  let date = 'today';
  let query = '';
  let expanded = null;
  let data = null;
  let status = 'idle';
  let request = null;
  let refreshTimer = null;
  let tickTimer = null;
  let settleTimer = null;
  /** The view's opening, for scrolling to "now" once, not on each refresh. */
  let scrollKey = 0;
  let near = null;
  let dismissed = null;
  let aircraft = { at: -Infinity, index: null };
  let layerTimers = [];

  async function load({ quiet = false } = {}) {
    if (!airport) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const forAirport = airport;
    if (!quiet) {
      status = 'loading';
      render();
    }
    try {
      const response = await fetchImpl(
        `/api/airport-board?iata=${forAirport.iata}&date=${date}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (destroyed || request !== controller || airport !== forAirport) return;
      data = body;
      status = 'ready';
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('[AirportBoard] load failed:', error?.message || error);
      if (request === controller) status = data ? 'ready' : 'error';
    } finally {
      if (request === controller) request = null;
    }
    render();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!airport || destroyed) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      // A hidden page waits for its next look (see `visible` below).
      if (documentRef?.visibilityState === 'hidden') return;
      void load({ quiet: true });
    }, REFRESH_MS);
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (airport && documentRef?.visibilityState !== 'hidden') render();
    }, TICK_MS);
  }

  const visible = () => {
    if (!airport || documentRef?.visibilityState === 'hidden') return;
    const age = now() - (data?.fetchedAt ?? 0);
    if (!refreshTimer || age >= REFRESH_MS) void load({ quiet: true });
  };
  documentRef?.addEventListener?.('visibilitychange', visible);

  // ---- the airport the view is over -----------------------------------------
  function viewCenter() {
    const height = viewer.camera.positionCartographic?.height;
    if (!Number.isFinite(height)) return null;
    const canvas = viewer.scene.canvas;
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    if (!hit) return null;
    const carto = Cesium.Cartographic.fromCartesian(hit);
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      height,
    };
  }

  function settle() {
    settleTimer = null;
    if (destroyed) return;
    const under = documentRef?.body?.classList?.contains('cockpit-mode')
      ? null
      : airportUnder(viewCenter());
    // Leaving an airport forgets that its card was closed.
    if (under?.iata !== dismissed) dismissed = null;
    if (under?.iata === near?.iata) return;
    near = under;
    render();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
  });

  // ---- aircraft in the air -------------------------------------------------------
  const flightsLayer = () =>
    dataManager?.isEnabled?.(FLIGHTS_LAYER)
      ? (dataManager.layers?.get(FLIGHTS_LAYER)?.module ?? null)
      : null;

  /** The live contacts by callsign and registration, read at most every 20 s. */
  function liveIndex() {
    const layer = flightsLayer();
    if (!layer?.getAllPositions) return null;
    if (now() - aircraft.at >= AIRCRAFT_INDEX_MS || !aircraft.index)
      aircraft = {
        at: now(),
        // A finite cap: the layer reads a non-finite one as its 500 default.
        index: aircraftIndex(layer.getAllPositions(AIRCRAFT_INDEX_MAX)),
      };
    return aircraft.index;
  }

  // ---- the view ----------------------------------------------------------------
  function flightRow(flight, kind, nowMs, before, index) {
    const tone = flightTone(flight, kind, nowMs);
    const late =
      flight.delayMinutes > 0 && tone !== 'gone' && tone !== 'canceled';
    const departing = kind === 'departures';
    const where = departing
      ? [flight.terminal, flight.gate].filter(Boolean).join(' · ')
      : flight.baggage?.belt
        ? t('belt {belt}', { belt: flight.baggage.belt })
        : flight.terminal || '';
    const open = expanded === flight.id;
    return {
      key: flight.id,
      time: clock(flight.planned),
      newTime: late ? clock(flight.expected) : '',
      place: bilingual(flight.place) || flight.placeIata || '—',
      via: flight.via?.length
        ? t('via {places}', {
            places: flight.via.map(bilingual).join(', '),
          })
        : '',
      flight: flight.flight,
      codeshares: flight.codeshares?.length
        ? `+${flight.codeshares.length}`
        : '',
      airline: flight.airline || '',
      where,
      status: flight.canceled
        ? t('Cancelled')
        : bilingual(flight.remark) || bilingual(flight.status),
      tone,
      // In the flights layer's air data: the row can follow its aircraft.
      live: Boolean(aircraftFor(flight, index)),
      nowBefore: before,
      open,
      details: open ? details(flight, kind) : null,
    };
  }

  function details(flight, kind) {
    const departing = kind === 'departures';
    const rows = [
      [t('Airline'), flight.airline],
      [
        t('Flight'),
        [flight.flight, flight.codeshares?.join(', ')]
          .filter(Boolean)
          .join(' · '),
      ],
      [t('Scheduled'), clock(flight.planned)],
      [
        t('Expected'),
        flight.expected !== flight.planned ? clock(flight.expected) : '',
      ],
      [departing ? t('Departed') : t('Landed'), clock(flight.actual)],
      [t('Terminal'), flight.terminal],
    ];
    if (departing)
      rows.push(
        [
          t('Check-in'),
          flight.checkIn
            ? [
                flight.checkIn.from === flight.checkIn.to
                  ? t('desk {desk}', { desk: flight.checkIn.from })
                  : t('desks {from}–{to}', {
                      from: flight.checkIn.from,
                      to: flight.checkIn.to,
                    }),
                bilingual(flight.checkIn.status),
              ]
                .filter(Boolean)
                .join(' · ')
            : '',
        ],
        [
          t('Gate'),
          [flight.gate, bilingual(flight.gateStatus)]
            .filter(Boolean)
            .join(' · '),
        ],
        [
          t('Gate open'),
          [flight.gateOpen, flight.gateClose]
            .filter(Boolean)
            .map(clock)
            .join('–'),
        ],
      );
    else
      rows.push(
        [t('Baggage belt'), flight.baggage?.belt],
        [t('First bag'), clock(flight.baggage?.first)],
        [t('Last bag'), clock(flight.baggage?.last)],
        [t('Gate'), flight.gate],
      );
    rows.push(
      [t('Route'), flight.scope ? t(SCOPES[flight.scope]) : ''],
      [t('Callsign'), flight.callsign],
      [t('Aircraft'), flight.registration],
    );
    return rows
      .filter(([, value]) => value)
      .map(([label, value]) => ({ label, value: String(value) }));
  }

  function flightsView(kind, nowMs) {
    const all = data?.[kind];
    if (!data?.flights)
      return { rows: [], empty: t('Flight times need the Swedavia key') };
    if (!all) return { rows: [], empty: '' };
    const kept = all.filter((flight) => matchesQuery(flight, query));
    const first = date === 'today' ? nowIndex(kept, nowMs) : -1;
    const index = liveIndex();
    return {
      rows: kept.map((flight, position) =>
        flightRow(flight, kind, nowMs, position === first, index),
      ),
      empty: kept.length
        ? ''
        : query
          ? t('No flights match “{query}”', { query })
          : t('No flights this day'),
      count: kept.length,
    };
  }

  function securityView() {
    if (!airport.queues)
      return {
        rows: [],
        empty: t(
          'Swedavia measures queues only at Arlanda, Landvetter and Bromma',
        ),
      };
    const queues = data?.security;
    if (!queues)
      return {
        rows: [],
        empty: t('Queue times need the Swedavia WaitTime key'),
      };
    return {
      rows: queues.map((queue) => ({
        key: queue.id || queue.name,
        name: queue.terminal
          ? t('Terminal {terminal}', {
              terminal: queue.terminal.replace(/^T/, ''),
            })
          : airport.name,
        lane: queue.fastTrack ? t('Fast track') : t('Ordinary lane'),
        minutes: t('{minutes} min', { minutes: queue.minutes }),
        level: queueLevel(queue.minutes, queue.overflow),
        fastTrack: queue.fastTrack,
        // Only a checkpoint with a position can be shown on the map.
        mapped: Number.isFinite(queue.lat) && Number.isFinite(queue.lon),
      })),
      empty: queues.length ? '' : t('No queue readings right now'),
    };
  }

  function boardView() {
    if (!airport) return null;
    const nowMs = now();
    const body =
      status === 'loading' && !data
        ? { rows: [], empty: t('Loading the board…') }
        : status === 'error' && !data
          ? { rows: [], empty: t('The board could not be read') }
          : tab === 'security'
            ? securityView()
            : flightsView(tab, nowMs);
    return {
      iata: airport.iata,
      name: airport.name,
      date: date,
      dateLabel: data?.date ? longDate(data.date) : '',
      updated: data?.updatedAt
        ? [
            t('Updated {time}', { time: clock(data.updatedAt) }),
            data.stale ? t('saved copy') : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '',
      loading: status === 'loading',
      tab,
      tabs: TABS.filter(([id]) => id !== 'security' || airport.queues).map(
        ([id, label, icon]) => ({
          id,
          label: t(label),
          icon,
          active: id === tab,
        }),
      ),
      query,
      kind: tab,
      // Following needs the flights layer; the board offers to turn it on.
      flightsOff: Boolean(dataManager) && !flightsLayer(),
      ...body,
      scrollKey,
    };
  }

  function render() {
    if (destroyed) return;
    publish({
      card:
        near && near.iata !== dismissed && near.iata !== airport?.iata
          ? {
              iata: near.iata,
              name: near.name,
              label: t('Departures and arrivals'),
            }
          : null,
      board: boardView(),
    });
  }

  // ---- actions -------------------------------------------------------------------
  function open(iata, nextTab = 'departures') {
    const next = swedaviaAirport(iata);
    if (!next) return;
    const same = airport?.iata === next.iata;
    airport = next;
    tab = nextTab === 'security' && !next.queues ? 'departures' : nextTab;
    if (!same) {
      date = 'today';
      query = '';
      expanded = null;
      data = null;
    }
    scrollKey += 1;
    startTick();
    void load();
  }

  function close() {
    airport = null;
    data = null;
    request?.abort();
    clearTimeout(refreshTimer);
    clearInterval(tickTimer);
    refreshTimer = tickTimer = null;
    status = 'idle';
    render();
  }

  const disconnect = connect({
    open,
    close,
    setTab(id) {
      if (!TABS.some(([known]) => known === id)) return;
      tab = id;
      expanded = null;
      scrollKey += 1;
      render();
    },
    setDate(next) {
      const value = next === 'tomorrow' ? 'tomorrow' : 'today';
      if (value === date) return;
      date = value;
      data = null;
      expanded = null;
      scrollKey += 1;
      void load();
    },
    setQuery(value) {
      query = String(value ?? '').slice(0, 40);
      render();
    },
    toggle(id) {
      expanded = expanded === id ? null : id;
      render();
    },
    refresh: () => load({ quiet: true }),
    dismissCard() {
      dismissed = near?.iata ?? null;
      render();
    },
    follow(id) {
      const flight = [
        ...(data?.departures ?? []),
        ...(data?.arrivals ?? []),
      ].find((row) => row.id === id);
      const icao24 = flight && aircraftFor(flight, liveIndex());
      const layer = flightsLayer();
      if (!icao24 || !layer?.trackById) return;
      // A followed aircraft keeps the camera moving, so no settle would take
      // the airport's card away: it goes with the board.
      near = null;
      close();
      layer.trackById(icao24, { origin: 'user' });
    },
    async enableFlights() {
      if (!dataManager?.setEnabled) return;
      await dataManager.setEnabled(FLIGHTS_LAYER, true, { origin: 'user' });
      // The first contacts arrive with the layer's first polls.
      aircraft = { at: -Infinity, index: null };
      for (const timer of layerTimers) clearTimeout(timer);
      layerTimers = [3000, 10_000, 25_000].map((ms) =>
        setTimeout(() => {
          aircraft = { at: -Infinity, index: null };
          render();
        }, ms),
      );
      render();
    },
    showQueue(key) {
      const queue = data?.security?.find((row) => (row.id || row.name) === key);
      if (!Number.isFinite(queue?.lat) || !Number.isFinite(queue?.lon)) return;
      close();
      // From the south, looking north over the checkpoint's terminal; its
      // label (src/ui/airportQueues.js) shows once the view settles.
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          queue.lon,
          queue.lat - QUEUE_VIEW_SOUTH_DEG,
          QUEUE_VIEW_HEIGHT_M,
        ),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-35),
          roll: 0,
        },
        duration: 2,
      });
    },
  });
  const removeLocale = onLocaleChange(render);

  return {
    open,
    close,
    destroy() {
      destroyed = true;
      request?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(settleTimer);
      clearInterval(tickTimer);
      for (const timer of layerTimers) clearTimeout(timer);
      removeMoveEnd?.();
      removeLocale?.();
      documentRef?.removeEventListener?.('visibilitychange', visible);
      disconnect?.();
      publish({ card: null, board: null });
    },
  };
}
