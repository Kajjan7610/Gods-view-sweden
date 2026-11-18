/** Card models for a selected stretch or measuring point. Pure — no Cesium types. */
import { msg, t } from '../../i18n/index.js';
import { queueColor } from './records.js';

export const ROAD_QUEUES_OVERLAY_SOURCE_ID = 'road-queues';

// Swedish data, Swedish clock.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const clock = (ms) => (Number.isFinite(ms) ? CLOCK.format(ms) : null);

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Every verdict as the legend and the cards name it. */
export const QUEUE_STATUS_LABELS = Object.freeze({
  impossible: msg('Standstill'),
  congested: msg('Queue'),
  heavy: msg('Slow traffic'),
  freeflow: msg('Free flow'),
  queue: msg('Queue'),
  slow: msg('Slow traffic'),
  normal: msg('Normal speed'),
  unknown: msg('No verdict'),
});

/** The direction a detector measures in, as Trafikverket names it. */
const DIRECTIONS = Object.freeze({
  northbound: msg('northbound'),
  northeastbound: msg('north-eastbound'),
  eastbound: msg('eastbound'),
  southeastbound: msg('south-eastbound'),
  southbound: msg('southbound'),
  southwestbound: msg('south-westbound'),
  westbound: msg('westbound'),
  northwestbound: msg('north-westbound'),
});

/** "northbound", or null for a side Trafikverket names otherwise. */
export function directionOf(side) {
  const key = String(side ?? '').toLowerCase();
  return DIRECTIONS[key] ? t(DIRECTIONS[key]) : null;
}

/** "1 min 20 s", or "45 s". */
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(s / 60);
  return minutes
    ? t('{minutes} min {seconds} s', { minutes, seconds: s % 60 })
    : t('{seconds} s', { seconds: s });
}

const label = (status) =>
  t(QUEUE_STATUS_LABELS[status] ?? QUEUE_STATUS_LABELS.unknown);

/** Card for one travel-time stretch. */
export function buildRouteCard(route) {
  const now = duration(route.travelTimeS);
  const normal = duration(route.normalS);
  const details = [
    now && normal
      ? t('Travel time {now}, normally {normal}', { now, normal })
      : now
        ? t('Travel time {now}', { now })
        : null,
    [
      Number.isFinite(route.speedKmh)
        ? t('{speed} km/h', { speed: Math.round(route.speedKmh) })
        : null,
      Number.isFinite(route.lengthM)
        ? t('{km} km', { km: (route.lengthM / 1000).toFixed(1) })
        : null,
    ]
      .filter(Boolean)
      .join(' · ') || null,
    t('Measured {time} · Trafikverket', { time: clock(route.measuredAt) }),
  ].filter(Boolean);
  return {
    ...CARD_BASE,
    id: `road-queues-card:r:${route.id}`,
    interactive: true,
    title: `${label(route.status).toUpperCase()} · ${route.name}`,
    details,
    accent: queueColor(route.status),
  };
}

/** Card for one measuring point: its lanes read together. */
export function buildPointCard(point) {
  const direction = directionOf(point.side);
  const speeds =
    Number.isFinite(point.speed) && Number.isFinite(point.normalSpeed)
      ? t('{speed} km/h now, normally {normal} km/h', {
          speed: Math.round(point.speed),
          normal: Math.round(point.normalSpeed),
        })
      : Number.isFinite(point.speed)
        ? t('{speed} km/h now', { speed: Math.round(point.speed) })
        : null;
  const flows = Number.isFinite(point.normalFlow)
    ? t('{flow} vehicles/h now, normally {normal}', {
        flow: point.flow,
        normal: point.normalFlow,
      })
    : t('{flow} vehicles/h now', { flow: point.flow });
  return {
    ...CARD_BASE,
    id: `road-queues-card:p:${point.id}`,
    interactive: true,
    title: t('MEASURING POINT · {status}', {
      status: label(point.status).toUpperCase(),
    }),
    details: [
      [direction, t('{count} lanes', { count: point.lanes })]
        .filter(Boolean)
        .join(' · '),
      speeds,
      flows,
      t('Measured {time} · Trafikverket', { time: clock(point.measuredAt) }),
    ].filter(Boolean),
    accent: queueColor(point.status),
  };
}
