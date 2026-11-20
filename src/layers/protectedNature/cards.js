/** Card text for a protected area. Pure — no Cesium types. */
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { KIND, allYear } from './records.js';

export const PROTECTED_NATURE_OVERLAY_SOURCE_ID = 'protected-nature';

const KIND_TITLES = Object.freeze({
  np: msg('NATIONAL PARK · {name}'),
  nr: msg('NATURE RESERVE · {name}'),
  kr: msg('CULTURE RESERVE · {name}'),
  n2k: msg('NATURA 2000 · {name}'),
  ban: msg('ACCESS BAN · {name}'),
});
/** A Natura 2000 area's directive(s), by its designation. */
const DESIGNATIONS = Object.freeze({
  spa: msg('Birds Directive (SPA)'),
  sci: msg('Habitats Directive (SCI)'),
  'spa-sci': msg('Birds and Habitats Directives (SPA/SCI)'),
});
/** An access ban's reason; "other" is told by no line of its own. */
const BAN_REASONS = Object.freeze({
  bird: msg('Bird protection'),
  seal: msg('Seal protection'),
  birdSeal: msg('Bird and seal protection'),
});
const DAY_MONTH = Object.freeze({
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * An area in hectares as "38,441 ha" or, from 1 000 ha, "384 km²"; a skerry
 * under a tenth of a hectare as "under 0.1 ha", never "0 ha".
 */
export function areaText(hectares) {
  if (!Number.isFinite(hectares)) return '';
  if (hectares < 0.1) return t('under {area} ha', { area: formatNumber(0.1) });
  return hectares >= 1000
    ? t('{area} km²', { area: formatNumber(Math.round(hectares / 100)) })
    : t('{area} ha', { area: formatNumber(hectares) });
}

/**
 * An access ban's period, "No entry 1 April – 31 July" in the reader's
 * language, or '' when the register gave none.
 * @param {number[]|undefined} period [fromDay, fromMonth, toDay, toMonth].
 */
export function banPeriodText(period) {
  if (!Array.isArray(period) || period.length !== 4) return '';
  if (allYear(period)) return t('No entry all year');
  const dayMonth = (day, month) =>
    formatDate(Date.UTC(2001, month - 1, day), DAY_MONTH);
  return t('No entry {from} – {to}', {
    from: dayMonth(period[0], period[1]),
    to: dayMonth(period[2], period[3]),
  });
}

/** The lines under a card's title that tell the kind of area apart. */
function kindDetails(area) {
  if (area.t === 'ban')
    return [
      area.k,
      [BAN_REASONS[area.s] ? t(BAN_REASONS[area.s]) : '', banPeriodText(area.p)]
        .filter(Boolean)
        .join(' · '),
      areaText(area.h),
    ];
  if (area.t === 'n2k')
    return [
      area.k,
      [
        areaText(area.h),
        Number.isFinite(area.y)
          ? t('in Natura 2000 since {year}', { year: area.y })
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      [DESIGNATIONS[area.d] ? t(DESIGNATIONS[area.d]) : '', area.i]
        .filter(Boolean)
        .join(' · '),
    ];
  return [
    area.k,
    [
      areaText(area.h),
      Number.isFinite(area.y)
        ? t('protected since {year}', { year: area.y })
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
  ];
}

/**
 * Card for one area; a linked card opens it in Skyddad natur.
 * @param {object} area A snapshot area.
 * @param {{linkable?: boolean}} [options]
 */
export function buildAreaCard(area, { linkable = false } = {}) {
  const details = [
    ...kindDetails(area),
    ...(linkable ? [t('Skyddad natur ↗ · click card to open')] : []),
    t('Source: Naturvårdsverket'),
  ].filter(Boolean);
  const title = t(KIND_TITLES[area.t] ?? KIND_TITLES.nr, { name: area.n });
  return {
    ...CARD_BASE,
    id: `protected-nature-card:${area.i}`,
    // Interactive only so a click on the card is told from one on the ground.
    interactive: true,
    ...(linkable
      ? {
          accessibilityLabel: t('Open {name} in Skyddad natur', {
            name: area.n,
          }),
        }
      : {}),
    title,
    details,
    accent: KIND[area.t]?.color ?? KIND.nr.color,
  };
}
