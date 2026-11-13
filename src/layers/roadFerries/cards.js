/** Card model for a selected road ferry route. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { statusColor } from './records.js';

export const ROAD_FERRIES_OVERLAY_SOURCE_ID = 'road-ferries';

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A departure time on Swedish clocks, "14:05". */
export function ferryClock(ms) {
  return Number.isFinite(ms) ? CLOCK.format(ms) : '';
}

/** One departure line: "14:05 Vaxholm → Rindö · note". */
export function departureLine(departure) {
  const leg =
    departure.from && departure.to
      ? `${departure.from} → ${departure.to}`
      : departure.from || departure.to || '';
  return [
    `${ferryClock(departure.at)} ${leg}`.trim(),
    departure.info?.[0] ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Card for one route. */
export function buildFerryCard(route) {
  const details = [
    ...(route.harbors.length > 1 ? [route.harbors.join(' – ')] : []),
    ...route.messages,
    ...(route.departures.length
      ? [t('Next departures:'), ...route.departures.map(departureLine)]
      : [t('No departures in the next three hours')]),
    // i18n-ignore: agency name
    `${t('Timetable and messages')} · Trafikverket`,
  ];
  return {
    ...CARD_BASE,
    id: `road-ferries-card:${route.id}`,
    interactive: true,
    title: t('ROAD FERRY · {route}', { route: route.name.toUpperCase() }),
    details,
    accent: statusColor(route.status),
  };
}
