/** Card model for a selected hospital. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { hospitalColor } from './records.js';

export const HOSPITALS_OVERLAY_SOURCE_ID = 'hospitals';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A median in minutes; from two hours on, as hours and minutes. */
export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 120)
    return t('{minutes} min', { minutes: Math.round(minutes) });
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest
    ? t('{hours} h {minutes} min', { hours, minutes: rest })
    : t('{hours} h', { hours });
}

/** A distance in metres or kilometres. */
export function formatHospitalDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  return metres < 1000
    ? `${formatNumber(Math.round(metres / 10) * 10)} m`
    : `${formatNumber(Math.round(metres / 100) / 10)} km`;
}

/** One median line with last year's figure when there is one. */
function medianLine(label, now, before) {
  if (!Number.isFinite(now)) return null;
  return Number.isFinite(before)
    ? t('{label}: {now} (2024: {before})', {
        label,
        now: formatMinutes(now),
        before: formatMinutes(before),
      })
    : t('{label}: {now}', { label, now: formatMinutes(now) });
}

function visitsLine(ed) {
  if (!Number.isFinite(ed.visits2025)) return null;
  const visits = formatNumber(ed.visits2025);
  if (!Number.isFinite(ed.visits2024) || ed.visits2024 <= 0)
    return t('Visits 2025: {visits}', { visits });
  const change = Math.round(
    ((ed.visits2025 - ed.visits2024) / ed.visits2024) * 100,
  );
  return t('Visits 2025: {visits} ({change} % on 2024)', {
    visits,
    change: change > 0 ? `+${change}` : String(change),
  });
}

/**
 * Card for one hospital.
 * @param {object} row A hospital, with `distance` from the map centre if any.
 * @param {{metric?: string, national?: object}} [context]
 */
export function buildHospitalCard(row, { metric = 'ttl', national = {} } = {}) {
  const ed = row.ed;
  const details = [
    ...(row.operator ? [row.operator] : []),
    ...(ed
      ? [
          medianLine(t('Time to physician'), ed.ttl2025, ed.ttl2024),
          medianLine(t('Total stay'), ed.tvt2025, ed.tvt2024),
          Number.isFinite(national.ttl2025) && Number.isFinite(national.tvt2025)
            ? t('Sweden: {ttl} to physician, {tvt} in total', {
                ttl: formatMinutes(national.ttl2025),
                tvt: formatMinutes(national.tvt2025),
              })
            : null,
          visitsLine(ed),
          ed.shared
            ? t('Figures for {department} as a whole', {
                department: ed.department,
              })
            : null,
          t('Yearly medians for adults, not a live wait'),
        ].filter(Boolean)
      : [t('Not in Socialstyrelsen’s emergency statistics; see 1177')]),
    ...(Number.isFinite(row.distance)
      ? [
          t('{distance} from the map centre', {
            distance: formatHospitalDistance(row.distance),
          }),
        ]
      : []),
    t('Life-threatening: call 112 · Advice: 1177'),
    // i18n-ignore: source names
    ed ? 'Socialstyrelsen · OpenStreetMap' : 'OpenStreetMap',
  ];
  return {
    ...CARD_BASE,
    id: `hospitals-card:${row.id}`,
    interactive: false,
    title: ed
      ? t('EMERGENCY · {name}', { name: row.name })
      : t('HOSPITAL · {name}', { name: row.name }),
    details,
    accent: hospitalColor(row, metric, national),
  };
}
