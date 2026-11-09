/** Card model for a selected hospital. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { hospitalColor, nationalMinutes } from './records.js';

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

/** One median line with the year before's figure when there is one. */
function medianLine(label, ed, metric, year) {
  const now = ed[`${metric}${year}`];
  const before = ed[`${metric}${year - 1}`];
  if (!Number.isFinite(now)) return null;
  return Number.isFinite(before)
    ? t('{label}: {now} ({previous}: {before})', {
        label,
        now: formatMinutes(now),
        previous: year - 1,
        before: formatMinutes(before),
      })
    : t('{label}: {now}', { label, now: formatMinutes(now) });
}

function visitsLine(ed, year) {
  const now = ed[`visits${year}`];
  const before = ed[`visits${year - 1}`];
  if (!Number.isFinite(now)) return null;
  const visits = formatNumber(now);
  if (!Number.isFinite(before) || before <= 0)
    return t('Visits {year}: {visits}', { year, visits });
  const change = Math.round(((now - before) / before) * 100);
  return t('Visits {year}: {visits} ({change} % on {previous})', {
    year,
    visits,
    change: change > 0 ? `+${change}` : String(change),
    previous: year - 1,
  });
}

/**
 * Card for one hospital.
 * @param {object} row A hospital, with `distance` from the map centre if any.
 * @param {{metric?: string, statistics?: object}} [context] The snapshot's
 *   statistics: their `year` and Sweden's medians.
 */
export function buildHospitalCard(
  row,
  { metric = 'ttl', statistics = {} } = {},
) {
  const ed = row.ed;
  const year = statistics.year;
  const ttl = nationalMinutes('ttl', statistics);
  const tvt = nationalMinutes('tvt', statistics);
  const details = [
    ...(row.operator ? [row.operator] : []),
    ...(ed
      ? [
          medianLine(t('Time to physician'), ed, 'ttl', year),
          medianLine(t('Total stay'), ed, 'tvt', year),
          ttl !== null && tvt !== null
            ? t('Sweden: {ttl} to physician, {tvt} in total', {
                ttl: formatMinutes(ttl),
                tvt: formatMinutes(tvt),
              })
            : null,
          visitsLine(ed, year),
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
    // Interactive only so a click on the card is told from one on the ground.
    interactive: true,
    title: ed
      ? t('EMERGENCY · {name}', { name: row.name })
      : t('HOSPITAL · {name}', { name: row.name }),
    details,
    accent: hospitalColor(row, metric, statistics),
  };
}
