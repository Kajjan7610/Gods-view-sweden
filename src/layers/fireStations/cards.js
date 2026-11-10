/** Card model for a selected fire station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { readinessColor } from './records.js';

export const FIRE_STATIONS_OVERLAY_SOURCE_ID = 'fire-stations';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Farthest from a municipal seat that a station still carries its name. */
const TITLE_PLACE_WITHIN_KM = 5;

/** The readiness form in the language. */
export function readinessLabel(id) {
  switch (id) {
    case 'full-time':
      return t('Full-time crew');
    case 'retained-officer':
      return t('Retained crew with a first-response officer');
    case 'retained':
      return t('Retained crew');
    case 'rescue-post':
      return t('Municipal rescue post');
    default:
      return t('Readiness not stated');
  }
}

/** Card for one station. */
export function buildFireStationCard(row) {
  const details = [
    readinessLabel(row.readiness),
    ...(row.near
      ? [
          row.near.km < 1
            ? t('In {place}', { place: row.near.name })
            : t('{km} km from {place}', {
                km: formatNumber(row.near.km),
                place: row.near.name,
              }),
        ]
      : []),
    // i18n-ignore: agency name
    `${t('Position as reported; accuracy varies')} · MCF`,
  ];
  return {
    ...CARD_BASE,
    id: `fire-stations-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: row.name
      ? t('FIRE STATION · {station}', { station: row.name.toUpperCase() })
      : row.near && row.near.km <= TITLE_PLACE_WITHIN_KM
        ? t('FIRE STATION · {station}', {
            station: row.near.name.toUpperCase(),
          })
        : t('FIRE STATION'),
    details,
    accent: readinessColor(row.readiness),
  };
}
