/** Legend and card text for the population squares. Pure — no Cesium types. */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { DENSITY_CLASSES, GRID_YEAR, shownDensity } from './records.js';

export const POPULATION_GRID_OVERLAY_SOURCE_ID = 'population-grid';

const CLASS_LABELS = Object.freeze([
  msg('under 1 per km²'),
  msg('{from}–{to} per km²'),
  msg('{from}+ per km²'),
]);

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A colour class's legend label, e.g. "20–99 per km²". */
export function classLabel(index) {
  const cls = DENSITY_CLASSES[index];
  if (!cls) return '';
  if (index === 0) return t(CLASS_LABELS[0]);
  const next = DENSITY_CLASSES[index + 1];
  return next
    ? t(CLASS_LABELS[1], {
        from: formatNumber(cls.from),
        to: formatNumber(next.from - 1),
      })
    : t(CLASS_LABELS[2], { from: formatNumber(cls.from) });
}

/** A density as the card shows it: "0.4", "49", "3,120". */
const densityText = (perKm2) =>
  formatNumber(perKm2, { maximumFractionDigits: perKm2 < 10 ? 1 : 0 });

/**
 * Card for a summed square (5, 10 or 25 km): its rounded people and people
 * per km². A 1 km square has no card.
 * @param {{id: string, km: number, people: number|null, cls: number}} square
 */
export function buildSquareCard(square) {
  const density = shownDensity(square);
  const details = [
    square.people === null
      ? t('fewer than 5 people')
      : t('about {count} people', { count: formatNumber(square.people) }),
    density === null
      ? t('under 1 per km²')
      : t('{density} per km²', { density: densityText(density) }),
    t('Summed from SCB’s 1 km grid, end of {year}', { year: GRID_YEAR }),
    t('Processed from SCB data'),
  ];
  return {
    ...CARD_BASE,
    id: `population-grid-card:${square.id}`,
    // Interactive only so a click on the card is told from one on the ground.
    interactive: true,
    title: t('POPULATION · {size} km square', { size: square.km }),
    details,
    accent: DENSITY_CLASSES[square.cls]?.color ?? DENSITY_CLASSES[0].color,
  };
}
