/**
 * The cockpit's Swedavia card (Swedish fork): while the cockpit flies an
 * aircraft that departs from or arrives at a Swedavia airport today, its own
 * board rows — times, gate, belt and the airport screens' line — show under
 * the flight plan. Found by callsign or registration through
 * /api/airport-flight, at the route's ends and the board it was followed
 * from (`hint`).
 */
import { getLocale, onLocaleChange, t } from '../i18n/index.js';
import { swedaviaAirportByCode } from '../data/swedaviaAirports.js';

/** The rows are read again this often while the cockpit flies the aircraft. */
const REFRESH_MS = 2 * 60_000;
/** The view's clocks (and "in N min") move on this often. */
const TICK_MS = 30_000;

const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
const bilingual = (value) =>
  !value
    ? ''
    : String(getLocale() || '').startsWith('sv')
      ? value.sv
      : value.en;

/**
 * One leg as the card shows it: what happens when, where at the airport, and
 * the airport's own line.
 */
export function legView(leg, nowMs) {
  const { flight, kind, airport } = leg;
  const departing = kind === 'departures';
  const delay = flight.delayMinutes > 0 ? flight.delayMinutes : 0;
  let time;
  if (flight.actual != null && flight.actual <= nowMs)
    time = departing
      ? t('Took off {time}', { time: clock(flight.actual) })
      : t('Landed {time}', { time: clock(flight.actual) });
  else if (flight.canceled) time = t('Cancelled');
  else {
    const minutes = Math.round((flight.expected - nowMs) / 60_000);
    time = [
      flight.expected !== flight.planned
        ? t('Expected {time}', { time: clock(flight.expected) })
        : t('Scheduled {time}', { time: clock(flight.planned) }),
      minutes > 0 && minutes < 180 ? t('in {minutes} min', { minutes }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return {
    key: `${airport.iata}:${kind}`,
    label: departing
      ? t('Departure · {airport}', { airport: airport.name })
      : t('Arrival · {airport}', { airport: airport.name }),
    time,
    delay: delay ? t('+{minutes} min', { minutes: delay }) : '',
    detail: [
      flight.terminal,
      flight.gate ? t('gate {gate}', { gate: flight.gate }) : '',
      !departing && flight.baggage?.belt
        ? t('belt {belt}', { belt: flight.baggage.belt })
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    status: bilingual(flight.remark) || bilingual(flight.status),
    tone: flight.canceled
      ? 'negative'
      : flight.remark?.tone === 'negative' || delay >= 15
        ? 'negative'
        : flight.remark?.tone === 'positive'
          ? 'positive'
          : 'neutral',
  };
}

/** Own the card for one app; `publish` receives the view or null. */
export function createCockpitFlightLeg({
  dataManager,
  publish,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  windowRef = globalThis.window,
}) {
  let destroyed = false;
  let active = false;
  let subject = null;
  let legs = null;
  let readAt = 0;
  let request = null;
  let tick = null;
  /** The airport each aircraft was followed from on the board. */
  const hints = new Map();

  function trackedInfo() {
    if (!subject) return null;
    const module = dataManager?.layers?.get(subject.layerId)?.module;
    const info = module?.getTrackedInfo?.();
    return info && String(info.icao24) === String(subject.id) ? info : null;
  }

  async function read() {
    const info = trackedInfo();
    if (!info) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const forSubject = subject;
    const airports = [info.origin, info.destination, hints.get(info.icao24)]
      .filter((code) => swedaviaAirportByCode(code))
      .join(',');
    const query = new URLSearchParams();
    if (info.callsign) query.set('callsign', info.callsign);
    if (info.registration) query.set('registration', info.registration);
    if (airports) query.set('airports', airports);
    if (!query.has('callsign') && !query.has('registration')) return;
    readAt = now();
    try {
      const response = await fetchImpl(`/api/airport-flight?${query}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (destroyed || subject !== forSubject) return;
      legs = Array.isArray(body?.legs) ? body.legs : [];
      render();
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn(
          '[CockpitFlightLeg] read failed:',
          error?.message || error,
        );
    } finally {
      if (request === controller) request = null;
    }
  }

  function render() {
    if (destroyed) return;
    if (!active || !legs?.length) {
      publish(null);
      return;
    }
    const first = legs[0].flight;
    publish({
      flight: [first.flight, first.airline].filter(Boolean).join(' · '),
      codeshares: first.codeshares?.length
        ? t('also {flights}', {
            flights: first.codeshares.slice(0, 3).join(', '),
          })
        : '',
      legs: legs.map((leg) => legView(leg, now())),
    });
  }

  function onCockpit(event) {
    const detail = event?.detail ?? {};
    active = detail.active === true;
    clearInterval(tick);
    tick = null;
    if (!active) {
      subject = null;
      legs = null;
      request?.abort();
      render();
      return;
    }
    const next = detail.subjectId
      ? { id: String(detail.subjectId), layerId: detail.layerId || 'flights' }
      : null;
    if (next?.id !== subject?.id) {
      subject = next;
      legs = null;
      render();
      void read();
    }
    tick = setInterval(() => {
      if (now() - readAt >= REFRESH_MS) void read();
      else render();
    }, TICK_MS);
  }
  windowRef?.addEventListener?.('gev:cockpit-mode-changed', onCockpit);
  const removeLocale = onLocaleChange(render);

  return {
    /** The board followed `icao24` from `iata`: search there too. */
    hint(icao24, iata) {
      if (icao24 && iata) hints.set(String(icao24), iata);
      if (hints.size > 50) hints.delete(hints.keys().next().value);
    },
    destroy() {
      destroyed = true;
      request?.abort();
      clearInterval(tick);
      windowRef?.removeEventListener?.('gev:cockpit-mode-changed', onCockpit);
      removeLocale?.();
      publish(null);
    },
  };
}
