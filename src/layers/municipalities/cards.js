/** Card and label text for municipalities. Pure — no Cesium types. */
import { formatDate, formatNumber, t } from '../../i18n/index.js';

export const MUNICIPALITIES_OVERLAY_SOURCE_ID = 'municipalities';
export const MUNICIPALITY_LABELS_SOURCE_ID = 'municipality-labels';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** SCB's month ("2026M08") as the last day of that month, or ''. */
export function formatPopulationDate(period) {
  const match = /^(\d{4})M(\d{2})$/.exec(String(period || ''));
  if (!match) return '';
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0));
  return formatDate(end, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The change over a year, as a signed percentage with one decimal, or ''. */
export function yearChange(now, before) {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0)
    return '';
  const change = Math.round(((now - before) / before) * 1000) / 10;
  const text = formatNumber(Math.abs(change), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${change > 0 ? '+' : change < 0 ? '−' : '±'}${text}`;
}

/** "161,947 people (+0.4 % in a year)" for an area. */
export function populationText(area) {
  if (!Number.isFinite(area?.population)) return '';
  const change = yearChange(area.population, area.populationYearAgo);
  const people = formatNumber(area.population);
  return change
    ? t('{people} people ({change} % in a year)', { people, change })
    : t('{people} people', { people });
}

/**
 * Card for one municipality.
 * @param {object} municipality
 * @param {{county?: object|null, populationPeriod?: string|null}} [context]
 */
export function buildMunicipalityCard(
  municipality,
  { county = null, populationPeriod = null } = {},
) {
  const date = formatPopulationDate(populationPeriod);
  const details = [
    ...(county ? [county.name] : []),
    ...(municipality.population
      ? [
          date
            ? t('{population} on {date}', {
                population: populationText(municipality),
                date,
              })
            : populationText(municipality),
        ]
      : []),
    ...(county?.population
      ? [
          t('{county}: {population}', {
            county: county.name,
            population: populationText(county),
          }),
        ]
      : []),
    t('Municipality code {code}', { code: municipality.code }),
    // i18n-ignore: source names
    'SCB · OpenStreetMap',
  ];
  return {
    ...CARD_BASE,
    id: `municipalities-card:${municipality.code}`,
    interactive: false,
    title: t('MUNICIPALITY · {name}', { name: municipality.name }),
    details,
    accent: '#80deea',
  };
}
