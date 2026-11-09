/** Card model for a selected police station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { deskClass, deskColor, nearestPassportDesk } from './records.js';

export const POLICE_STATIONS_OVERLAY_SOURCE_ID = 'police-stations';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A desk service in the language. */
export function serviceLabel(id) {
  switch (id) {
    case 'passport-apply':
      return t('Apply for a passport or ID card');
    case 'passport-collect':
      return t('Collect a passport or ID card');
    case 'temporary-passport':
      return t('Apply for a temporary passport');
    case 'report':
      return t('Report a crime or lost property');
    case 'found-property':
      return t('Hand in found property');
    case 'seized-property':
      return t('Collect seized property');
    case 'weapons':
      return t('Hand in weapons');
    case 'temporary-plate':
      return t('Collect a temporary number plate');
    case 'general-hours':
      return t('General opening hours');
    default:
      return t('Other matters');
  }
}

/** A desk class in the language, for the legend. */
export function deskLabel(id) {
  switch (id) {
    case 'passport':
      return t('Passports and ID cards');
    case 'desk':
      return t('Public desk, no passports');
    default:
      return t('No desk services listed');
  }
}

/**
 * Card for one station.
 * @param {object} row A normalized station.
 * @param {object} [options]
 * @param {object[]} [options.stations] Every station, for the nearest
 *   passport desk.
 * @param {boolean} [options.linkable] Whether a click can open its page.
 */
export function buildPoliceStationCard(
  row,
  { stations = [], linkable = false } = {},
) {
  const link = linkable && row.url;
  const passportDesk =
    deskClass(row) === 'passport' ? null : nearestPassportDesk(row, stations);
  const details = [
    ...(row.address ? [row.address] : []),
    ...(row.services.length
      ? row.services.map(serviceLabel)
      : [t('No desk services listed')]),
    ...(passportDesk?.row.name
      ? [
          t('Nearest passport desk: {name}, {km} km', {
            name: passportDesk.row.name,
            km: formatNumber(Math.round(passportDesk.km)),
          }),
        ]
      : []),
    ...(link ? [t('Opening hours on polisen.se ↗ · click card to open')] : []),
    // i18n-ignore: agency name
    'Polismyndigheten',
  ];
  const title = row.name
    ? t('POLICE STATION · {station}', { station: row.name.toUpperCase() })
    : t('POLICE STATION');
  return {
    ...CARD_BASE,
    id: `police-stations-card:${row.id}`,
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open the web page of {title}', { title }) }
      : undefined),
    title,
    details,
    accent: deskColor(row),
  };
}
