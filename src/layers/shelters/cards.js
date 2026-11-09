/** Card model for a selected shelter. Pure — no Cesium types. */
import { formatNumber, t, tn } from '../../i18n/index.js';
import { shelterColor } from './records.js';

export const SHELTERS_OVERLAY_SOURCE_ID = 'shelters';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A distance in metres or kilometres. */
export function formatShelterDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  // Rounded first, so 996 m reads "1 km" and not "1,000 m".
  const tens = Math.round(metres / 10) * 10;
  return tens < 1000
    ? `${formatNumber(tens)} m`
    : `${formatNumber(Math.round(metres / 100) / 10)} km`;
}

/** The places of a shelter, or of several. */
export function placesText(count) {
  return tn(count, '{count} place', '{count} places', {
    count: formatNumber(count),
  });
}

/** Card for one shelter. */
export function buildShelterCard(row) {
  const details = [
    ...(row.property ? [t('Property {name}', { name: row.property })] : []),
    ...(row.places ? [placesText(row.places)] : []),
    ...(row.limited ? [t('Temporarily restricted')] : []),
    ...(row.special ? [t('Special shelter')] : []),
    ...(Number.isFinite(row.distance)
      ? [
          t('{distance} from the map centre', {
            distance: formatShelterDistance(row.distance),
          }),
        ]
      : []),
    t('For use in heightened alert; listen to VMA'),
    // i18n-ignore: agency name
    'MCF',
  ];
  return {
    ...CARD_BASE,
    id: `shelters-card:${row.id}`,
    interactive: true,
    title: row.number
      ? t('SHELTER · {number}', { number: row.number })
      : t('SHELTER'),
    details,
    accent: shelterColor(row),
  };
}
