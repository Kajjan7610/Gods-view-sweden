/** Card text for a protected area. Pure — no Cesium types. */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { KIND } from './records.js';

export const PROTECTED_NATURE_OVERLAY_SOURCE_ID = 'protected-nature';

const KIND_TITLES = Object.freeze({
  np: msg('NATIONAL PARK · {name}'),
  nr: msg('NATURE RESERVE · {name}'),
  kr: msg('CULTURE RESERVE · {name}'),
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** An area in hectares as "38,441 ha" or, from 1 000 ha, "384 km²". */
export function areaText(hectares) {
  if (!Number.isFinite(hectares)) return '';
  return hectares >= 1000
    ? t('{area} km²', { area: formatNumber(Math.round(hectares / 100)) })
    : t('{area} ha', { area: formatNumber(hectares) });
}

/**
 * Card for one area; a linked card opens it in Skyddad natur.
 * @param {object} area A snapshot area.
 * @param {{linkable?: boolean}} [options]
 */
export function buildAreaCard(area, { linkable = false } = {}) {
  const details = [
    area.k,
    [
      areaText(area.h),
      Number.isFinite(area.y)
        ? t('protected since {year}', { year: area.y })
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
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
